import { Command } from 'commander';
import * as store from '../core/session-store.js';
import * as anchors from '../core/anchor-store.js';
import { collectListeners, inspectSession } from '../core/inventory.js';
import { killAndWait } from '../core/process-guard.js';
import { clearActivePort } from '../core/devtools-port.js';
import { formatTable, success, info, error } from '../output/formatter.js';

export function registerAnchorCommands(program: Command): void {
  const anchor = program
    .command('anchor')
    .description('Stable directory targets for a browser MCP (separate from the CLI\'s active session)');

  anchor
    .command('ls')
    .description('List anchors, what they point at, and whether that target is ours')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const all = anchors.list();

      if (opts.json) {
        const rows = [];
        for (const a of all) {
          const meta = a.session ? store.get(a.session) : null;
          const inv = meta ? await inspectSession(meta) : null;
          rows.push({ ...a, ownership: inv?.ownership ?? null, port: inv?.resolvedPort ?? null });
        }
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      if (all.length === 0) {
        info(`No anchors. Use "tirno anchor set <anchor> <session>" to create one.`);
        return;
      }

      const listeners = await collectListeners();
      const rows = [];
      for (const a of all) {
        let meta = null;
        try { meta = a.session ? store.get(a.session) : null; } catch { /* ledger entry gone */ }
        const inv = meta ? await inspectSession(meta, listeners) : null;
        rows.push([
          a.name,
          a.session ?? (a.live ? '(no session)' : '(dangling)'),
          inv ? String(inv.resolvedPort ?? '-') : '-',
          inv?.ownership ?? (a.live ? 'unknown' : 'dangling'),
          a.target,
        ]);
      }
      console.log(formatTable(['ANCHOR', 'SESSION', 'PORT', 'OWNER', 'TARGET'], rows));
    });

  anchor
    .command('set')
    .description('Point an anchor at a session profile (replaces the symlink)')
    .argument('<anchor>', 'Anchor name')
    .argument('<session>', 'Session name')
    .option('--evict', 'Also kill the chrome the anchor pointed at before, so a connected MCP reconnects to the new one')
    .action(async (anchorName: string, sessionName: string, opts) => {
      try {
        const { previous } = anchors.set(anchorName, sessionName);
        const now = anchors.read(anchorName);
        success(`Anchor '${anchorName}' → ${now?.target} (session '${sessionName}')`);

        const movedFrom = previous && previous.session !== sessionName ? previous : null;

        if (opts.evict) {
          if (movedFrom) {
            await evictPrevious(movedFrom);
          } else {
            // --evict only knows the browser this command displaced. If the
            // anchor was already moved in an earlier run, that browser is no
            // longer "previous" and has to be named directly.
            info('Anchor already pointed at this session — nothing to evict. If an MCP is still attached to another browser, kill that session directly: tirno kill <session>');
          }
        } else if (movedFrom?.session) {
          // browser.js caches a connected browser, so an MCP that is already
          // attached keeps talking to the old chrome until that connection drops
          info(`Previous target '${movedFrom.session}' is still running — an already-connected MCP will keep using it. Re-run with --evict to switch it over.`);
        }
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  anchor
    .command('rm')
    .description('Remove an anchor symlink (the profile it pointed at is left alone)')
    .argument('<anchor>', 'Anchor name')
    .action((anchorName: string) => {
      try {
        anchors.remove(anchorName);
        success(`Removed anchor '${anchorName}' (profile untouched)`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}

/**
 * Kill the browser the anchor used to point at. Goes through the same ownership
 * check as `tirno kill`: an anchor pointing at someone else's browser is not a
 * licence to kill it.
 */
async function evictPrevious(previous: anchors.Anchor | null): Promise<void> {
  if (!previous?.session) {
    info('Nothing to evict — the anchor pointed at no known session.');
    return;
  }

  let meta;
  try {
    meta = store.get(previous.session);
  } catch {
    info(`Nothing to evict — session '${previous.session}' is no longer in the ledger.`);
    return;
  }

  const inv = await inspectSession(meta);
  if (inv.ownership === 'ghost') {
    info(`Nothing to evict — '${previous.session}' was not running.`);
    return;
  }
  if (inv.ownership !== 'ours') {
    error(`Refusing to evict '${previous.session}' — ${inv.ownership}: ${inv.reason}`);
    return;
  }

  await killAndWait(meta.pid);
  clearActivePort(meta.userDataDir);
  success(`Evicted '${previous.session}' (PID ${meta.pid}); its session entry is kept`);
}
