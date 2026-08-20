import { Command } from 'commander';
import { intArg } from '../util/parsers.js';
import * as store from '../core/session-store.js';
import { launch } from '../core/chrome-launcher.js';
import { isAlive, killAndWait } from '../core/process-guard.js';
import { formatTable, success, info, error } from '../output/formatter.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const NEW_DEFAULT_DESC = 'Create a new Chrome session';

function summarizeFlags(flags: string[]): string {
  // user flags only — strip the ones tirno injects
  const builtins = new Set([
    '--remote-debugging-port',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1920,1080',
    '--window-position=0,0',
  ]);
  const userFlags = flags.filter(f => {
    const head = f.split('=')[0];
    return !builtins.has(head) && !f.startsWith('--remote-debugging-port=');
  });
  if (userFlags.length === 0) return '-';
  const joined = userFlags.join(' ');
  return joined.length > 80 ? joined.slice(0, 77) + '...' : joined;
}

export function registerSessionCommands(program: Command): void {
  const newCmd = program
    .command('new')
    .description(NEW_DEFAULT_DESC)
    .argument('<name>', 'Session name')
    .argument('[url]', 'Optional URL — chrome opens directly, skipping about:blank')
    .option('-p, --port <port>', 'DevTools port (auto-assign if omitted)', intArg)
    .option('--headless', 'Run in headless mode')
    .option('--executable-path <path>', 'Path to Chrome executable')
    .option('-f, --force', 'If a session with this name exists, kill it first and re-create')
    .option('--ephemeral', 'Use a temporary user-data-dir; cleaned on kill')
    .option('--group <name>', 'Tag this session with a group label')
    .option('--url <url>', 'Same as positional [url] — kept for backward compat');

  // Chrome flags come after "--": tirno new test -- --no-proxy-server
  newCmd.allowUnknownOption(true);
  newCmd.allowExcessArguments(true);

  newCmd.action(async (name: string, urlArg: string | undefined, opts) => {
    try {
      const rawArgs = process.argv;
      const dashDashIdx = rawArgs.indexOf('--');
      const chromeFlags = dashDashIdx >= 0 ? rawArgs.slice(dashDashIdx + 1) : [];
      // positional [url] takes precedence; --url stays as backward-compat alias.
      const bootUrl: string | undefined = urlArg ?? opts.url;

      // wish A — same-name re-run handling
      let existing: store.SessionMetadata | null = null;
      try { existing = store.get(name); } catch { /* not found, fine */ }
      if (existing) {
        if (!opts.force) {
          throw new Error(
            `Session '${name}' already exists. Use --force to kill and re-create with new flags.`
          );
        }
        try { await killAndWait(existing.pid); } catch { /* already dead */ }
        if (opts.ephemeral || existing.userDataDir.startsWith(os.tmpdir())) {
          fs.rmSync(existing.userDataDir, { recursive: true, force: true });
        } else {
          // Chrome leaves SingletonLock symlinks pointing to dead pids; new
          // launch on the same user-data-dir hangs waiting for them.
          for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
            try { fs.unlinkSync(`${existing.userDataDir}/${f}`); } catch { /* ok */ }
          }
        }
        store.remove(name);
        if (store.getActive() === name) store.clearActive();
      }

      // wish E — ephemeral profile
      let userDataDirOverride: string | undefined;
      if (opts.ephemeral) {
        userDataDirOverride = fs.mkdtempSync(path.join(os.tmpdir(), `tirno-${name}-`));
      }

      const meta = await launch({
        name,
        port: opts.port,
        chromeFlags,
        executablePath: opts.executablePath,
        headless: opts.headless,
        userDataDir: userDataDirOverride,
        bootUrl,
      });

      // wish F — group tag
      if (opts.group) {
        store.update(name, { group: opts.group });
      }

      success(`Session '${name}' created (port ${meta.port}, PID ${meta.pid}${opts.group ? `, group: ${opts.group}` : ''}${opts.ephemeral ? ', ephemeral' : ''}${bootUrl ? `, url: ${bootUrl}` : ''})`);
    } catch (e) {
      error((e as Error).message);
      process.exit(1);
    }
  });

  // wish A alias — restart
  program
    .command('restart')
    .description('Kill existing session (if any) and re-create with new chrome flags')
    .argument('<name>', 'Session name')
    .argument('[url]', 'Optional URL — chrome opens directly, skipping about:blank')
    .option('-p, --port <port>', 'DevTools port', intArg)
    .option('--headless', 'Run headless')
    .option('--executable-path <path>', 'Chrome path')
    .option('--ephemeral', 'Use a temporary user-data-dir')
    .option('--group <name>', 'Group label')
    .option('--url <url>', 'Same as positional [url] — kept for backward compat')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (name: string, urlArg: string | undefined, opts) => {
      const rawArgs = process.argv;
      const dashDashIdx = rawArgs.indexOf('--');
      const chromeFlags = dashDashIdx >= 0 ? rawArgs.slice(dashDashIdx + 1) : [];
      const bootUrl: string | undefined = urlArg ?? opts.url;
      // delegate to `new --force` semantics inline (avoid extra subprocess)
      try {
        let existing: store.SessionMetadata | null = null;
        try { existing = store.get(name); } catch { /* none */ }
        if (existing) {
          try { await killAndWait(existing.pid); } catch { /* dead */ }
          if (opts.ephemeral || existing.userDataDir.startsWith(os.tmpdir())) {
            fs.rmSync(existing.userDataDir, { recursive: true, force: true });
          }
          store.remove(name);
          if (store.getActive() === name) store.clearActive();
        }
        let userDataDirOverride: string | undefined;
        if (opts.ephemeral) {
          userDataDirOverride = fs.mkdtempSync(path.join(os.tmpdir(), `tirno-${name}-`));
        }
        const meta = await launch({
          name,
          port: opts.port,
          chromeFlags,
          executablePath: opts.executablePath,
          headless: opts.headless,
          userDataDir: userDataDirOverride,
          bootUrl,
        });
        if (opts.group) store.update(name, { group: opts.group });
        success(`Session '${name}' restarted (port ${meta.port}, PID ${meta.pid}${opts.group ? `, group: ${opts.group}` : ''}${bootUrl ? `, url: ${bootUrl}` : ''})`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('ls')
    .description('List all sessions')
    .option('--json', 'Output as JSON')
    .option('--group <name>', 'Filter by group')
    .option('--flags', 'Include FLAGS column (truncated to 80 chars)')
    .action((opts) => {
      let sessions = store.list();
      const active = store.getActive();
      if (opts.group) sessions = sessions.filter(s => s.group === opts.group);

      if (opts.json) {
        console.log(JSON.stringify(sessions, null, 2));
        return;
      }

      if (sessions.length === 0) {
        info('No sessions. Use "tirno new <name>" to create one.');
        return;
      }

      const showFlags = opts.flags === true;
      const showGroup = sessions.some(s => s.group);

      const headers = ['', 'NAME', 'PORT', 'STATUS', 'PROXY', 'EMULATION'];
      if (showGroup) headers.push('GROUP');
      if (showFlags) headers.push('FLAGS');
      headers.push('LAST ACCESS');

      const rows = sessions.map(s => {
        const alive = isAlive(s.pid);
        const marker = s.name === active ? '*' : ' ';
        const status = alive ? 'running' : 'dead';
        const proxy = s.chromeFlags.find(f => f.startsWith('--proxy'))?.split('=')[1] ?? 'direct';
        const emu = s.emulation;
        const parts: string[] = [];
        if (emu?.device) {
          const vp = emu.viewport;
          parts.push(vp ? `${emu.device} (${vp.width}x${vp.height}@${vp.deviceScaleFactor}x)` : emu.device);
        } else if (emu?.viewport) {
          const vp = emu.viewport;
          parts.push(`${vp.width}x${vp.height}@${vp.deviceScaleFactor}x`);
        }
        if (emu?.network) parts.push(`net:${emu.network}`);
        if (emu?.cpu) parts.push(`cpu:${emu.cpu}x`);
        const emulation = parts.length ? parts.join(', ') : '-';
        const row = [marker, s.name, String(s.port), status, proxy, emulation];
        if (showGroup) row.push(s.group ?? '-');
        if (showFlags) row.push(summarizeFlags(s.chromeFlags));
        row.push(s.lastAccessedAt.slice(0, 19).replace('T', ' '));
        return row;
      });

      console.log(formatTable(headers, rows));
    });

  program
    .command('attach')
    .description('Set active session')
    .argument('<name>', 'Session name')
    .action((name: string) => {
      try {
        store.get(name);
        store.setActive(name);
        success(`Active session: ${name}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('kill')
    .description('Kill a session')
    .argument('[name]', 'Session name')
    .option('--all', 'Kill all sessions')
    .option('--group <name>', 'Kill all sessions in this group')
    .option('--clean', 'Remove profile directory')
    .action(async (name: string | undefined, opts) => {
      try {
        let targets: store.SessionMetadata[];
        if (opts.all) targets = store.list();
        else if (opts.group) targets = store.list().filter(s => s.group === opts.group);
        else if (name) targets = [store.get(name)];
        else throw new Error('Provide a name, --all, or --group <name>');

        if (targets.length === 0) {
          info(`No sessions match`);
          return;
        }

        for (const meta of targets) {
          await killAndWait(meta.pid);
          store.remove(meta.name);

          // ephemeral dirs always cleaned; otherwise --clean
          const isEphemeral = meta.userDataDir.startsWith(os.tmpdir());
          if (opts.clean || isEphemeral) {
            fs.rmSync(meta.userDataDir, { recursive: true, force: true });
          }

          if (store.getActive() === meta.name) store.clearActive();
          success(`Killed '${meta.name}' (PID ${meta.pid}${isEphemeral ? ', ephemeral cleaned' : opts.clean ? ', profile cleaned' : ''})`);
        }
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('rename')
    .description('Rename a session')
    .argument('<old>', 'Current name')
    .argument('<new>', 'New name')
    .action((oldName: string, newName: string) => {
      try {
        store.rename(oldName, newName);
        success(`Renamed '${oldName}' → '${newName}'`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('export')
    .description('Export session config')
    .argument('<name>', 'Session name')
    .action((name: string) => {
      try {
        const meta = store.get(name);
        console.log(JSON.stringify(meta, null, 2));
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  // broadcast group support is in commands/multi.ts; we just expose --group filter from there
}
