import { Command } from 'commander';
import { intArg } from '../util/parsers.js';
import * as store from '../core/session-store.js';
import { launch } from '../core/chrome-launcher.js';
import { connectWithoutPageSetup } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import type { Cookie } from 'puppeteer-core';
import { isAlive, killAndWait } from '../core/process-guard.js';
import { clearActivePort } from '../core/devtools-port.js';
import { collectListeners, inspectSession, type SessionInventory } from '../core/inventory.js';
import * as gc from '../core/gc.js';
import * as drift from '../core/drift.js';
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

/**
 * Everything after `--` is meant for chrome, but commander hands those args to
 * the action as operands too, so the first chrome flag also lands in `[url]`
 * (`tirno new x -- --no-proxy-server` recorded `url: --no-proxy-server` and
 * passed the flag to chrome twice). A positional url only counts when it
 * appeared before the separator.
 */
export function positionalUrl(
  rawArgs: string[],
  dashDashIdx: number,
  urlArg: string | undefined,
): string | undefined {
  if (urlArg === undefined) return undefined;
  const beforeSeparator = dashDashIdx >= 0 ? rawArgs.slice(0, dashDashIdx) : rawArgs;
  return beforeSeparator.includes(urlArg) ? urlArg : undefined;
}


/**
 * `kill` refuses to touch a process it cannot prove is ours, but `new --force`
 * and `restart` were sending SIGTERM to the ledger's pid outright — the same
 * hole the ownership check exists to close, since a recycled pid belongs to
 * someone else by then. Verified: a session whose pid had been taken over was
 * reported `foreign`, `kill` refused it, and `restart` killed it anyway.
 *
 * Refusing the whole command is the wrong answer here — `tirno drift` tells
 * people to run `restart`, so that path has to keep working. Leave the stranger
 * alone and build the new session anyway; the old entry was only ever a label.
 *
 * Returns whether the old browser was actually ours, because the profile
 * directory must not be deleted either when it was not.
 */
async function killIfOurs(meta: store.SessionMetadata, verb: string): Promise<boolean> {
  const inv = await inspectSession(meta);
  if (inv.ownership === 'foreign' || inv.ownership === 'ambiguous') {
    info(`Leaving pid ${meta.pid} alone — ${inv.ownership}: ${inv.reason}`);
    info(`${verb} continues with a fresh browser; the old entry was a stale label.`);
    return false;
  }
  try { await killAndWait(meta.pid); } catch { /* already dead */ }
  return true;
}

export function registerSessionCommands(program: Command): void {
  const newCmd = program
    .command('new')
    .description(NEW_DEFAULT_DESC)
    .argument('<name>', 'Session name')
    .argument('[url]', 'Optional URL — chrome opens directly, skipping about:blank')
    .option('-p, --port <port>', 'Pin a fixed DevTools port. Omit to let the OS assign one — required for browser-MCP anchoring', intArg)
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
      const bootUrl: string | undefined = positionalUrl(rawArgs, dashDashIdx, urlArg) ?? opts.url;

      // wish A — same-name re-run handling
      let existing: store.SessionMetadata | null = null;
      try { existing = store.get(name); } catch { /* not found, fine */ }
      if (existing) {
        if (!opts.force) {
          throw new Error(
            `Session '${name}' already exists. Use --force to kill and re-create with new flags.`
          );
        }
        const wasOurs = await killIfOurs(existing, '--force');
        if (wasOurs && (opts.ephemeral || existing.userDataDir.startsWith(os.tmpdir()))) {
          fs.rmSync(existing.userDataDir, { recursive: true, force: true });
        } else if (wasOurs) {
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
        // Not inherited from `existing`, unlike `restart`. `--force` discards the
        // old chrome flags outright — the message that sends people here says
        // "re-create with new flags" — so inheriting only the binary would leave
        // the session half-respecified.
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

      // A fixed port makes chrome skip DevToolsActivePort entirely (measured),
      // so a directory-anchored browser MCP has nothing to read.
      if (opts.port !== undefined) {
        info(`--port ${opts.port} pins a fixed port; chrome writes no DevToolsActivePort, so this session cannot be a browser-MCP anchor target. Omit --port for that.`);
      }
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
    .option('-p, --port <port>', 'Pin a fixed DevTools port (omit to let the OS assign one)', intArg)
    .option('--headless', 'Run headless')
    .option('--executable-path <path>', 'Chrome path')
    .option('--ephemeral', 'Use a temporary user-data-dir')
    .option('--group <name>', 'Group label')
    .option('--keep-cookies', 'Carry cookies across the restart, session cookies included — otherwise the login dies with the browser')
    .option('--url <url>', 'Same as positional [url] — kept for backward compat')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (name: string, urlArg: string | undefined, opts) => {
      const rawArgs = process.argv;
      const dashDashIdx = rawArgs.indexOf('--');
      const chromeFlags = dashDashIdx >= 0 ? rawArgs.slice(dashDashIdx + 1) : [];
      const bootUrl: string | undefined = positionalUrl(rawArgs, dashDashIdx, urlArg) ?? opts.url;
      // `new --force` semantics inline (no extra subprocess), except that this
      // is the same session coming back: executablePath and group carry over.
      try {
        let existing: store.SessionMetadata | null = null;
        try { existing = store.get(name); } catch { /* none */ }

        // 재기동은 브라우저를 죽인다. `Expires` 없는 쿠키는 거기서 같이 죽으므로
        // 프로필은 남아도 로그인은 안 남는다 — 로그인 뒤의 화면을 보러 재기동하는
        // 흐름에서는 그것이 기본 경로가 된다.
        //
        // 실패하면 재기동하지 않는다. 이 옵션을 준 이유가 그 쿠키인데, 못 챙긴 채
        // 진행하면 되돌릴 수 없는 자리에서 목적만 조용히 사라진다.
        let saved: Cookie[] = [];
        if (opts.keepCookies && existing) {
          const { browser } = await connectWithoutPageSetup(name);
          try {
            saved = await browser.cookies();
          } finally {
            browser.disconnect();
          }
        }

        if (existing) {
          const wasOurs = await killIfOurs(existing, 'restart');
          if (wasOurs && (opts.ephemeral || existing.userDataDir.startsWith(os.tmpdir()))) {
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
          executablePath: opts.executablePath ?? existing?.executablePath,
          headless: opts.headless,
          userDataDir: userDataDirOverride,
          bootUrl,
        });
        // The group tag survives a restart. `kill --group` and `broadcast --group`
        // select on it, so dropping it silently takes the session out of every
        // group operation the caller set it up for.
        //
        // `headless` deliberately does not survive: there is no `--no-headless`,
        // so inheriting it would leave no way back to a headful browser.
        const group = opts.group ?? existing?.group;
        if (group) store.update(name, { group });

        if (saved.length) {
          const { browser } = await connectWithoutPageSetup(name);
          try {
            await browser.setCookie(...saved);
            // 쿠키보다 먼저 나간 첫 요청은 로그인 화면을 받는다. 그 상태로 두면
            // 쿠키는 살렸는데 화면은 로그아웃인, 가장 헷갈리는 자리가 된다.
            if (bootUrl) await (await getActivePage(browser)).reload();
          } finally {
            browser.disconnect();
          }
        }

        success(`Session '${name}' restarted (port ${meta.port}, PID ${meta.pid}${group ? `, group: ${group}` : ''}${bootUrl ? `, url: ${bootUrl}` : ''}${saved.length ? `, ${saved.length} cookie(s) carried` : ''})`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('ls')
    .description('List all sessions (OWNER is observed, not from the ledger: ours|foreign|ambiguous|ghost)')
    .option('--json', 'Output as JSON')
    .option('--group <name>', 'Filter by group')
    .option('--flags', 'Include FLAGS column (truncated to 80 chars)')
    .action(async (opts) => {
      let sessions = store.list();
      const active = store.getActive();
      if (opts.group) sessions = sessions.filter(s => s.group === opts.group);

      // One lsof for the whole list; each session is then matched against it.
      const listeners = sessions.length ? await collectListeners() : [];
      const owner = new Map<string, SessionInventory>();
      for (const s of sessions) owner.set(s.name, await inspectSession(s, listeners));

      if (opts.json) {
        console.log(JSON.stringify(
          sessions.map(s => {
            const inv = owner.get(s.name);
            return { ...s, ownership: inv?.ownership, ownershipReason: inv?.reason, resolvedPort: inv?.resolvedPort };
          }),
          null, 2,
        ));
        return;
      }

      if (sessions.length === 0) {
        info('No sessions. Use "tirno new <name>" to create one.');
        return;
      }

      const showFlags = opts.flags === true;
      const showGroup = sessions.some(s => s.group);

      const headers = ['', 'NAME', 'PORT', 'STATUS', 'OWNER', 'PROXY', 'EMULATION'];
      if (showGroup) headers.push('GROUP');
      if (showFlags) headers.push('FLAGS');
      headers.push('LAST ACCESS');

      const rows = sessions.map(s => {
        const inv = owner.get(s.name);
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
        // Name the squatter rather than just flagging it — "foreign" alone
        // reads like a tirno bug, "foreign(OtherAgentApp)" reads like the
        // fact it is.
        const squatter = inv?.listeners.find(l => l.pid !== s.pid)?.command;
        const ownership = inv
          ? inv.ownership === 'foreign' && squatter ? `foreign(${squatter})` : inv.ownership
          : '?';
        const row = [marker, s.name, String(inv?.resolvedPort ?? s.port), status, ownership, proxy, emulation];
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
    .description('Kill a session (refuses foreign/ambiguous ports — see "tirno ls")')
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

        const listeners = await collectListeners();
        let failures = 0;

        for (const meta of targets) {
          // Each session is handled on its own. `--all` and `--group` used to
          // abort at the first exception, leaving every session after it
          // running under an entry that says it was killed.
          try {
            // The ledger says this pid is ours; observation gets the final word.
            // Killing on the ledger's say-so is how a stale entry turns into
            // "tirno killed an unrelated app". Refuse and name it —
            // ghosts still pass, since killing a dead pid is a no-op.
            const inv = await inspectSession(meta, listeners);
            if (inv.ownership === 'foreign' || inv.ownership === 'ambiguous') {
              error(`Refusing to kill '${meta.name}' — ${inv.ownership}: ${inv.reason}`);
              failures++;
              continue;
            }

            await killAndWait(meta.pid);
            // Chrome leaves DevToolsActivePort behind on every exit path, and a
            // leftover makes the next MCP attach fail with an opaque
            // `ECONNREFUSED <port>` instead of "no browser here".
            clearActivePort(meta.userDataDir);
            store.remove(meta.name);

            // ephemeral dirs always cleaned; otherwise --clean
            const isEphemeral = meta.userDataDir.startsWith(os.tmpdir());
            if (opts.clean || isEphemeral) {
              fs.rmSync(meta.userDataDir, { recursive: true, force: true });
            }

            if (store.getActive() === meta.name) store.clearActive();
            success(`Killed '${meta.name}' (PID ${meta.pid}${isEphemeral ? ', ephemeral cleaned' : opts.clean ? ', profile cleaned' : ''})`);
          } catch (e) {
            error(`Failed on '${meta.name}': ${(e as Error).message}`);
            failures++;
          }
        }

        // A refusal or an error is a failure — the browser the caller named is
        // still running. Exiting 0 tells a script the kill happened, which is the
        // one thing it must not believe here.
        if (failures > 0) process.exit(1);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('gc')
    .description('Clean up stale bookkeeping (ghost/foreign entries, leftover DevToolsActivePort). Never kills a browser; never removes an anchored, active or live profile')
    .option('--dry-run', 'Show what would be removed, change nothing')
    .option('--older-than <days>', 'Also delete orphan profiles unused for this many days (destructive: a profile is a logged-in session)', intArg)
    .action(async (opts) => {
      try {
        const scanned = await gc.scan();
        const plan = gc.plan(scanned, { olderThanDays: opts.olderThan }, new Date());

        for (const s of plan.skipped) info(`keep ${s.target} — ${s.reason}`);

        if (plan.actions.length === 0) {
          info('Nothing to clean.');
          return;
        }

        // Size and last-used are printed before deleting, not after: a profile
        // directory is someone's logged-in browser session.
        for (const a of plan.actions) {
          const detail = [
            a.sizeKb !== undefined ? `${(a.sizeKb / 1024).toFixed(1)} MB` : null,
            a.lastUsed ? `last used ${a.lastUsed}` : null,
          ].filter(Boolean).join(', ');
          info(`${opts.dryRun ? 'would remove' : 'remove'} ${a.kind} ${a.target}${detail ? ` (${detail})` : ''} — ${a.reason}`);
        }

        const result = gc.apply(plan, opts.dryRun === true);
        for (const f of result.failed) error(`failed on ${f.action.target}: ${f.error}`);

        if (opts.dryRun) {
          info(`Dry run — nothing changed. ${result.applied.length} item(s) would be removed.`);
        } else {
          success(`Removed ${result.applied.length} item(s)${result.failed.length ? `, ${result.failed.length} failed` : ''}`);
          // Printed failures are still failures — a caller reading only $? was
          // told the cleanup succeeded.
          if (result.failed.length > 0) process.exit(1);
        }
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  const driftCmd = program
    .command('drift')
    .description('Compare chrome flags against the running process; pass "-- <flags>" to check what you want now instead of what was declared. Exits non-zero when they differ')
    .argument('[name]', 'Session name (default: active session)')
    .option('--all', 'Also print the full running command line')
    .allowUnknownOption(true)
    .allowExcessArguments(true);

  driftCmd.action(async (name: string | undefined, opts) => {
    try {
      // Flags after `--` are "what I want now" — that is how a caller whose
      // routing config changed asks whether this session needs a restart,
      // without tirno having to understand the config.
      const rawArgs = process.argv;
      const dashDashIdx = rawArgs.indexOf('--');
      const expected = dashDashIdx >= 0 ? rawArgs.slice(dashDashIdx + 1) : undefined;

      const target = name ?? store.getActive();
      if (!target) throw new Error('No active session. Provide a name or use "tirno attach <name>"');
      const meta = store.get(target);

      const d = await drift.inspectDrift(meta, expected);

      if (d.inventory.ownership !== 'ours') {
        error(`Cannot inspect '${target}' — ${d.inventory.ownership}: ${d.inventory.reason}`);
        process.exit(1);
      }

      if (opts.all) info(`running: ${d.cmdline}`);

      for (const c of d.unverifiable) {
        info(`unreadable  ${c.flag}: declared ${c.expected ?? '(no value)'} — the running command line shows only "${c.actual ?? ''}", because a value containing " --" cannot be read back from it. Not reported as drift.`);
      }

      if (!d.hasDrift) {
        success(`'${target}' matches its ${d.expectedSource === 'ledger' ? 'declared flags' : 'expected flags'}`);
        return;
      }

      for (const c of d.missing) {
        info(`missing  ${c.flag}${c.expected === null ? '' : `=${c.expected}`}`);
      }
      for (const c of d.changed) {
        info(`changed  ${c.flag}: expected ${c.expected ?? '(no value)'}, running ${c.actual ?? '(no value)'}`);
      }

      // The suggestion has to rebuild the session, not just its chrome flags.
      // Headless-ness, the ephemeral profile and the boot URL are not in
      // chromeFlags, and restart defaults each one off: pasting a command
      // without them turns a headless session headful, and turns an ephemeral
      // one into a profile directory under ~/.tirno/profiles that nothing will
      // clean up. --remote-debugging-port stays out on purpose — port 0 is
      // tirno's to pick, and it is what makes the profile anchorable.
      const flags = d.expected
        .filter(f => f.startsWith('--') && !f.startsWith('--remote-debugging-port'))
        .map(drift.shellQuoteFlag);
      const bootUrl = meta.chromeFlags.find(f => !f.startsWith('--'));
      const parts = [`tirno restart ${target}`];
      if (bootUrl) parts.push(bootUrl);
      if (/(?:^|\s)--headless(?:[=\s]|$)/.test(d.cmdline ?? '')) parts.push('--headless');
      if (meta.userDataDir.startsWith(os.tmpdir())) parts.push('--ephemeral');
      if (meta.group) parts.push(`--group ${meta.group}`);
      if (flags.length) parts.push(`-- ${flags.join(' ')}`);
      error(`'${target}' has drifted. Chrome only reads these at launch — restart to apply:`);
      info(`  ${parts.join(' ')}`);
      process.exit(1);
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
