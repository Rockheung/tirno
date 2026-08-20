// OS keychain wrapper for secrets (API keys etc).
//
// Lookup order: env → keychain → null.
// Stored under service "tirno" with account = key name (e.g. "ANTHROPIC_API_KEY").
//
// Backends:
//   - macOS:  /usr/bin/security (built-in)
//   - Linux:  secret-tool (libsecret-tools, install via package manager)
//   - Windows: not yet implemented (env-only fallback)
//
// All keychain calls go through child_process — zero npm deps.

import { spawnSync } from 'node:child_process';

const SERVICE = 'tirno';

export type Platform = 'darwin' | 'linux' | 'win32' | 'other';

function platform(): Platform {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'win32') return 'win32';
  return 'other';
}

export interface KeychainResult {
  source: 'env' | 'keychain' | null;
  value: string | null;
}

/** Returns secret value if found, with source. env wins over keychain. */
export function get(name: string): KeychainResult {
  const fromEnv = process.env[name];
  if (fromEnv) return { source: 'env', value: fromEnv };
  const fromKc = readKeychain(name);
  if (fromKc) return { source: 'keychain', value: fromKc };
  return { source: null, value: null };
}

/** Persist to OS keychain. Returns true on success. */
export function set(name: string, value: string): boolean {
  return writeKeychain(name, value);
}

/** Remove from OS keychain. Returns true if removed (or didn't exist). */
export function remove(name: string): boolean {
  return deleteKeychain(name);
}

/** List names stored in keychain under service 'tirno'. May be incomplete on Linux. */
export function list(): string[] {
  return listKeychain();
}

// ─── platform-specific impls ───────────────────────────────────────────

function readKeychain(name: string): string | null {
  switch (platform()) {
    case 'darwin': return readDarwin(name);
    case 'linux': return readLinux(name);
    default: return null;
  }
}

function writeKeychain(name: string, value: string): boolean {
  switch (platform()) {
    case 'darwin': return writeDarwin(name, value);
    case 'linux': return writeLinux(name, value);
    default: return false;
  }
}

function deleteKeychain(name: string): boolean {
  switch (platform()) {
    case 'darwin': return deleteDarwin(name);
    case 'linux': return deleteLinux(name);
    default: return false;
  }
}

function listKeychain(): string[] {
  switch (platform()) {
    case 'darwin': return listDarwin();
    case 'linux': return listLinux();
    default: return [];
  }
}

// ─── macOS (`security`) ────────────────────────────────────────────────

function readDarwin(name: string): string | null {
  const r = spawnSync('/usr/bin/security', [
    'find-generic-password', '-s', SERVICE, '-a', name, '-w',
  ], { encoding: 'utf-8' });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

function writeDarwin(name: string, value: string): boolean {
  // -U updates if exists; cleaner than delete+add
  const r = spawnSync('/usr/bin/security', [
    'add-generic-password', '-U', '-s', SERVICE, '-a', name, '-w', value,
  ], { encoding: 'utf-8' });
  return r.status === 0;
}

function deleteDarwin(name: string): boolean {
  const r = spawnSync('/usr/bin/security', [
    'delete-generic-password', '-s', SERVICE, '-a', name,
  ], { encoding: 'utf-8' });
  // 44 = "could not be found"; treat as already-removed
  return r.status === 0 || r.status === 44;
}

function listDarwin(): string[] {
  // `security dump-keychain` is heavy + output flaky. Use the 'find' loop
  // approach: there's no direct list-by-service. We iterate the well-known
  // names instead — caller passes a hint. For now: read from env first.
  // As fallback: enumerate via dump-keychain | grep.
  const r = spawnSync('bash', ['-lc',
    `security dump-keychain 2>/dev/null | awk -v s="${SERVICE}" '
       /"svce"<blob>=/{ getline; }
       /"svce"<blob>="' "${SERVICE}" '"/{found=1}
       /"acct"<blob>=/ && found { gsub(/.*<blob>=|"/, "", $0); print; found=0 }
     '`,
  ], { encoding: 'utf-8' });
  if (r.status !== 0) return [];
  return r.stdout.split('\n').map(l => l.trim()).filter(Boolean);
}

// ─── Linux (`secret-tool` from libsecret-tools) ────────────────────────

function readLinux(name: string): string | null {
  const r = spawnSync('secret-tool', ['lookup', 'service', SERVICE, 'account', name], { encoding: 'utf-8' });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

function writeLinux(name: string, value: string): boolean {
  const r = spawnSync('secret-tool',
    ['store', '--label=' + `tirno:${name}`, 'service', SERVICE, 'account', name],
    { encoding: 'utf-8', input: value },
  );
  return r.status === 0;
}

function deleteLinux(name: string): boolean {
  const r = spawnSync('secret-tool', ['clear', 'service', SERVICE, 'account', name], { encoding: 'utf-8' });
  return r.status === 0;
}

function listLinux(): string[] {
  const r = spawnSync('secret-tool', ['search', '--all', '--unlock', 'service', SERVICE], { encoding: 'utf-8' });
  if (r.status !== 0) return [];
  // output format: "[/secret/X]\nlabel = ...\nsecret = ...\nattribute.account = NAME\n..."
  const out: string[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^attribute\.account\s*=\s*(.+)$/.exec(line.trim());
    if (m) out.push(m[1]);
  }
  return out;
}
