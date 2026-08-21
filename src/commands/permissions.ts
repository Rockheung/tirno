import { Command } from 'commander';
import * as store from '../core/session-store.js';
import { connect } from '../core/chrome-connector.js';
import { applyPermissions, normalizeOrigin, validatePermissions, PERMISSION_NAMES, type PermissionMap } from '../cdp/permissions.js';
import { formatTable, success, info, warn, error } from '../output/formatter.js';
import { NoActiveSession } from '../util/errors.js';

function targetSession(opts: { session?: string }): string {
  const name = opts.session ?? store.getActive();
  if (!name) throw new NoActiveSession();
  return name;
}

/**
 * Write the ledger first, then push it to the browser. The order matters when
 * the session is dead: the grant is still recorded and takes effect the next
 * time anything connects, instead of being lost with the failed connect.
 */
async function saveAndApply(name: string, next: PermissionMap): Promise<void> {
  store.update(name, { permissions: next });
  try {
    const { browser } = await connect(name);
    await applyPermissions(browser, next);
    browser.disconnect();
  } catch (e) {
    warn(`Saved, but not applied to a running browser: ${(e as Error).message}`);
    info('It applies on the next command that connects.');
  }
}

export function registerPermissionCommands(program: Command): void {
  const perms = program
    .command('permissions')
    .alias('perm')
    .description('Origin permission grants that survive between commands (Chrome drops a raw CDP grant when the command ends)');

  perms
    .command('ls')
    .description('List the grants stored for a session')
    .option('-s, --session <name>', 'Session name')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      try {
        const meta = store.get(targetSession(opts));
        const map = meta.permissions ?? {};

        if (opts.json) {
          console.log(JSON.stringify(map, null, 2));
          return;
        }
        const origins = Object.keys(map);
        if (origins.length === 0) {
          info(`No grants for session '${meta.name}'. Use "tirno permissions grant <origin> <permission...>".`);
          return;
        }
        console.log(formatTable(['ORIGIN', 'PERMISSIONS'], origins.map(o => [o, map[o].join(', ')])));
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  perms
    .command('grant')
    .description('Grant permissions to an origin and remember them for this session')
    .argument('<origin>', 'Origin, e.g. https://example.com')
    .argument('<permissions...>', `One or more of: ${PERMISSION_NAMES.join(', ')}`)
    .option('-s, --session <name>', 'Session name')
    .action(async (originArg: string, names: string[], opts) => {
      try {
        const name = targetSession(opts);
        const origin = normalizeOrigin(originArg);
        const granted = validatePermissions(names);

        const meta = store.get(name);
        const next: PermissionMap = { ...(meta.permissions ?? {}), [origin]: granted };
        await saveAndApply(name, next);
        success(`${origin} → ${granted.join(', ')}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  perms
    .command('revoke')
    .description('Drop the grants for one origin, or for every origin when none is given')
    .argument('[origin]', 'Origin to revoke; omit to revoke all')
    .option('-s, --session <name>', 'Session name')
    .action(async (originArg: string | undefined, opts) => {
      try {
        const name = targetSession(opts);
        const meta = store.get(name);
        const current = meta.permissions ?? {};

        let next: PermissionMap;
        if (originArg) {
          const origin = normalizeOrigin(originArg);
          if (!(origin in current)) {
            info(`Nothing granted to ${origin} in session '${name}'.`);
            return;
          }
          next = { ...current };
          delete next[origin];
        } else {
          next = {};
        }

        await saveAndApply(name, next);
        success(originArg ? `Revoked ${normalizeOrigin(originArg)}` : `Revoked every grant in session '${name}'`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}
