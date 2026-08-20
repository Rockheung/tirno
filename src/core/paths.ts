import path from 'node:path';
import os from 'node:os';

/**
 * The one root every tirno store resolves from.
 *
 * `TIRNO_DIR` moves **all** of it. Anything that resolves its own path from
 * `os.homedir()` writes to the real `~/.tirno` no matter what the caller set —
 * and that directory holds profiles (logged-in browser sessions) and the visual
 * cache (the journal this tool exists to keep). A store outside the root is a
 * store a test or a smoke run can destroy while believing it is isolated.
 *
 * Resolved per call, not once at import: a module-level constant freezes the
 * root before a test that imports the module can set the variable.
 */
export function tirnoDir(): string {
  return process.env.TIRNO_DIR ?? path.join(os.homedir(), '.tirno');
}

/** A path inside the root. Use this instead of joining `homedir()` again. */
export function underRoot(...parts: string[]): string {
  return path.join(tirnoDir(), ...parts);
}
