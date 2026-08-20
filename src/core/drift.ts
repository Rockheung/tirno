import type { SessionMetadata } from './session-store.js';
import { parseFlags, readCmdline, inspectSession, type SessionInventory } from './inventory.js';

/**
 * "Is this browser still running with the options we think it has?"
 *
 * `chromeFlags` in the ledger is what tirno *passed at launch*, not what the
 * process is running now, and the two can disagree — a live chrome can carry
 * flags (`--remote-debugging-address=127.0.0.1`) that no current source of the
 * tool that launched it declares anywhere.
 *
 * The other half is intent drift: launch-time flags like
 * `--host-resolver-rules` are a snapshot chrome takes once and never re-reads,
 * so when the caller's routing config changes, the running browser silently
 * keeps the old rules. tirno does not parse those rules (it has no idea what
 * they mean, by design) — it only reports that declared and actual differ, and
 * that fixing it means a restart.
 *
 * Restarting is cheap: the OS picks the port, the profile persists so
 * logins survive, and a directory-anchored MCP reconnects on its next call.
 */

/**
 * Quote a flag so the suggested restart command survives a copy-paste.
 * `--host-resolver-rules=MAP example.com 127.0.0.1` is a single argument with
 * spaces in it; unquoted it becomes three.
 */
export function shellQuoteFlag(flag: string): string {
  if (!/[\s'"$`\\|&;<>()*?[\]{}!#~]/.test(flag)) return flag;
  const eq = flag.indexOf('=');
  if (eq === -1) return `'${flag.replace(/'/g, `'\\''`)}'`;
  const name = flag.slice(0, eq);
  const value = flag.slice(eq + 1).replace(/'/g, `'\\''`);
  return `${name}='${value}'`;
}

export interface FlagChange {
  flag: string;
  /** null = the flag was given with no value */
  expected: string | null;
  actual: string | null;
}

export interface DriftReport {
  /** declared but absent from the running process */
  missing: FlagChange[];
  /** present in both, with different values */
  changed: FlagChange[];
  hasDrift: boolean;
}

/**
 * Compares only what was expected. Extra flags are NOT reported: puppeteer and
 * chrome add dozens of their own (`--disable-background-networking`, …), so
 * "present but not declared" is the normal case, not a defect — flagging it
 * would bury the two signals that do mean something.
 */
export function diffFlags(expected: string[], actual: Map<string, string | null>): DriftReport {
  const missing: FlagChange[] = [];
  const changed: FlagChange[] = [];

  for (const raw of expected) {
    if (!raw.startsWith('--')) continue;         // start URLs and other positionals
    const eq = raw.indexOf('=');
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const want = eq === -1 ? null : raw.slice(eq + 1);

    if (!actual.has(flag)) {
      missing.push({ flag, expected: want, actual: null });
      continue;
    }
    const got = actual.get(flag) ?? null;
    if (got !== want) changed.push({ flag, expected: want, actual: got });
  }

  return { missing, changed, hasDrift: missing.length > 0 || changed.length > 0 };
}

export interface SessionDrift extends DriftReport {
  name: string;
  inventory: SessionInventory;
  /** the running command line, for `--all` */
  cmdline: string | null;
  /** what was compared against — the ledger's flags, or flags the caller supplied */
  expected: string[];
  expectedSource: 'ledger' | 'argument';
}

/**
 * `expected` overrides the ledger: that is how "my routing config changed, does
 * this session need a restart?" gets answered without tirno understanding the
 * config.
 */
export async function inspectDrift(meta: SessionMetadata, expected?: string[]): Promise<SessionDrift> {
  const inventory = await inspectSession(meta);
  const cmdline = inventory.ownership === 'ours' ? await readCmdline(meta.pid) : null;
  const want = expected ?? meta.chromeFlags;
  const report = cmdline
    ? diffFlags(want, parseFlags(cmdline))
    : { missing: [], changed: [], hasDrift: false };

  return {
    ...report,
    name: meta.name,
    inventory,
    cmdline,
    expected: want,
    expectedSource: expected ? 'argument' : 'ledger',
  };
}
