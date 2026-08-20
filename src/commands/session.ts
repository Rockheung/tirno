import { Command } from 'commander';
import * as store from '../core/session-store.js';
import { launch } from '../core/chrome-launcher.js';
import { isAlive } from '../core/process-guard.js';
import { killAndWait } from '../core/process-guard.js';
import { formatTable, success, info, warn, error } from '../output/formatter.js';

export function registerSessionCommands(program: Command): void {
  const newCmd = program
    .command('new')
    .description('Create a new Chrome session')
    .argument('<name>', 'Session name')
    .option('-p, --port <port>', 'DevTools port (auto-assign if omitted)', parseInt)
    .option('--headless', 'Run in headless mode')
    .option('--executable-path <path>', 'Path to Chrome executable');

  // Chrome flags come after "--": wandr new test -- --no-proxy-server
  newCmd.allowUnknownOption(true);
  newCmd.allowExcessArguments(true);

  newCmd.action(async (name: string, opts, cmd) => {
      try {
        // parse raw argv to extract everything after "--"
        const rawArgs = process.argv;
        const dashDashIdx = rawArgs.indexOf('--');
        const chromeFlags = dashDashIdx >= 0 ? rawArgs.slice(dashDashIdx + 1) : [];

        const meta = await launch({
          name,
          port: opts.port,
          chromeFlags,
          executablePath: opts.executablePath,
          headless: opts.headless,
        });

        success(`Session '${name}' created (port ${meta.port}, PID ${meta.pid})`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('ls')
    .description('List all sessions')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      const sessions = store.list();
      const active = store.getActive();

      if (opts.json) {
        console.log(JSON.stringify(sessions, null, 2));
        return;
      }

      if (sessions.length === 0) {
        info('No sessions. Use "wandr new <name>" to create one.');
        return;
      }

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
        return [
          marker,
          s.name,
          String(s.port),
          status,
          proxy,
          emulation,
          s.lastAccessedAt.slice(0, 19).replace('T', ' '),
        ];
      });

      console.log(formatTable(
        ['', 'NAME', 'PORT', 'STATUS', 'PROXY', 'EMULATION', 'LAST ACCESS'],
        rows
      ));
    });

  program
    .command('attach')
    .description('Set active session')
    .argument('<name>', 'Session name')
    .action((name: string) => {
      try {
        store.get(name); // validate exists
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
    .option('--clean', 'Remove profile directory')
    .action(async (name: string | undefined, opts) => {
      try {
        const targets = opts.all ? store.list() : [store.get(name!)];

        for (const meta of targets) {
          await killAndWait(meta.pid);
          store.remove(meta.name);

          if (opts.clean) {
            const { rmSync } = await import('node:fs');
            rmSync(meta.userDataDir, { recursive: true, force: true });
          }

          if (store.getActive() === meta.name) store.clearActive();
          success(`Killed '${meta.name}' (PID ${meta.pid})`);
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
}
