import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 자기 자신을 GitHub Releases 의 최신 바이너리로 갈아 끼운다.
 *
 * 스킬은 여기서 건드리지 않는다. Claude Code 가 플러그인을 자기 상태로 관리하므로
 * 파일을 직접 만지면 그 상태와 어긋난다 — `claude plugin` 을 부르는 것이 맞다.
 */

export const REPO = 'Rockheung/tirno';

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  assets: ReleaseAsset[];
}

/**
 * 이 플랫폼이 받을 파일 이름. 릴리즈 워크플로의 매트릭스와 같은 규칙이다
 * (`tirno-bun-<platform>-<arch>`).
 *
 * Windows 는 대상이 아니다 — 소유권 판정이 `lsof` 와 `ps` 를 읽는다.
 */
export function assetNameFor(platform: string, arch: string): string {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null;
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
  if (!os || !cpu) throw new Error(`No release binary for ${platform}/${arch} — build from source`);
  return `tirno-bun-${os}-${cpu}`;
}

/** `<sha256>  <파일명>` 줄들. sha256sum 이 내는 형식 그대로다. */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

/**
 * semver 비교. `0.2.10` 이 `0.2.9` 보다 낮다고 판정하는 문자열 비교로는
 * "최신입니다" 를 틀리게 말하게 된다.
 *
 * 프리릴리즈는 비교하지 않고 무시한다 — 이 저장소가 내지 않는다.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * 지금 도는 것이 갈아 끼울 수 있는 단일 실행 파일인가.
 *
 * bun 으로 컴파일한 바이너리는 `process.execPath` 가 자기 자신이다. `bun run`,
 * `node bin/tirno.js`, npm link 는 execPath 가 런타임을 가리키므로 대상이 아니다 —
 * 그 경우 런타임을 덮어쓰게 된다.
 */
export function selfReplaceTarget(execPath: string, bunVersion: string | undefined): string | null {
  if (!bunVersion) return null;
  const base = path.basename(execPath);
  if (base === 'bun' || base === 'bun.exe') return null;
  return execPath;
}

/** 설치된 플러그인 하나 — `claude plugin` 이 받는 식별자와 그 버전. */
export interface InstalledPlugin {
  /** `tirno@tirno` — `<플러그인>@<마켓플레이스>` */
  id: string;
  /** `@` 뒤. `claude plugin marketplace update` 가 받는다 */
  marketplace: string;
  /** scope 마다 항목이 하나씩이라 그중 가장 낮은 것 */
  version: string;
}

/**
 * Claude Code 가 설치해 둔 플러그인. 식별자와 버전을 **한 번에** 돌려준다.
 *
 * 바이너리와 플러그인은 따로 설치되고 따로 낡는다 — 릴리즈 바이너리를 직접 받아
 * 쓰다가 `update` 로 갈아타면 바이너리만 최신이고 플러그인은 처음 설치 시점에
 * 멈춰 있다. 그래서 각각 읽어야 한다.
 *
 * 식별자를 값으로 돌려주는 이유는, 버전을 읽는 쪽과 갱신을 부르는 쪽이 `tirno@tirno`
 * 라는 같은 가정을 각자 들고 있으면 한쪽만 어긋나도 **버전은 읽으면서 갱신은 다른
 * 곳을 부르는** 상태가 되기 때문이다. 설치된 키가 하나뿐인 출처다.
 *
 * 항목은 scope(user/local)마다 하나씩 배열로 들어 있다. 하나라도 낡았으면 갱신할
 * 것이 있으므로 가장 낮은 버전을 기준으로 삼는다.
 */
export function installedPluginFrom(raw: string, name = 'tirno'): InstalledPlugin | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const plugins = (parsed as { plugins?: Record<string, unknown> })?.plugins;
  if (!plugins || typeof plugins !== 'object') return null;

  // 마켓플레이스 이름은 `marketplace.json` 이 정하므로 저장소를 fork 하면 달라진다.
  // 이름으로 찾고 뒤는 읽어 쓴다.
  const id = Object.keys(plugins).find(k => k.startsWith(`${name}@`));
  if (!id) return null;

  const entries = plugins[id];
  if (!Array.isArray(entries)) return null;

  const versions = entries
    .map(e => (e as { version?: unknown })?.version)
    .filter((v): v is string => typeof v === 'string' && /^\d+\.\d+/.test(v));
  if (!versions.length) return null;

  return {
    id,
    marketplace: id.slice(name.length + 1),
    version: versions.reduce((lowest, v) => (compareVersions(v, lowest) < 0 ? v : lowest)),
  };
}

/** `~/.claude/plugins/installed_plugins.json`. CLAUDE_CONFIG_DIR 가 있으면 그쪽. */
export function installedPluginsPath(home: string, configDir?: string): string {
  return path.join(configDir ?? path.join(home, '.claude'), 'plugins', 'installed_plugins.json');
}

export function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 같은 디렉터리에 받아서 rename 으로 바꿔치운다.
 *
 * 같은 파일시스템이라 rename 이 atomic 이고, 도중에 죽어도 반쯤 쓰인 바이너리가
 * 남지 않는다. 실행 중인 자기 자신을 덮어써도 되는 이유는 POSIX 가 열려 있는
 * inode 를 살려 두기 때문이다 — 지금 프로세스는 옛것으로 끝까지 돈다.
 */
export function replaceBinary(target: string, data: Buffer): void {
  const dir = path.dirname(target);
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    throw new Error(`No write permission on ${dir} — re-run with permission, or replace ${target} by hand`);
  }
  const tmp = path.join(dir, `.tirno-update-${process.pid}`);
  try {
    fs.writeFileSync(tmp, data, { mode: 0o755 });
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 이미 없다 */ }
    throw e;
  }
}
