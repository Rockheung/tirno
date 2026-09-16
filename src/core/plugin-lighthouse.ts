/**
 * lighthouse 를 플러그인으로 (#216).
 *
 * `tirno audit` 하나가 쓰는 lighthouse 가 puppeteer-core·@opentelemetry 를 끌고 바이너리의
 * 절반을 차지했다. "raw CDP 위, 런타임 의존 0" 이 코드에서는 참인데 번들에서는 아니었다.
 * 그래서 번들에서 뺀다 — import 를 **계산된 경로**로 해서 번들러가 따라오지 못하게 하고,
 * 실행 시점에 찾는다. CLAUDE.md 의 "덜어낸 것" 절이 OCR·임베딩에 쓴 규율과 같다.
 *
 * 찾는 순서(구체적인 것이 이긴다): `$TIRNO_LIGHTHOUSE` → `~/.tirno/plugins/audit` →
 * 전역 npm(`npm root -g`) → 이 레포의 node_modules(개발·스모크용).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { underRoot } from './paths.js';

export const PLUGIN_DIR_NAME = 'plugins/audit';

export function pluginRoot(): string {
  return underRoot(PLUGIN_DIR_NAME);
}

/** `<root>/node_modules/lighthouse` 가 있으면 그 진입 파일 */
function entryUnder(root: string): string | null {
  const pkgDir = path.join(root, 'node_modules', 'lighthouse');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { main?: string; exports?: unknown };
    const exp = pkg.exports as { '.'?: { import?: string } | string } | undefined;
    const rel = (typeof exp?.['.'] === 'string' ? exp['.'] : exp?.['.']?.import) ?? pkg.main ?? 'core/index.js';
    const entry = path.join(pkgDir, rel);
    return fs.existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

export interface LighthouseLocation { entry: string; source: 'env' | 'plugin' | 'global' | 'repo' }

export function locateLighthouse(env: NodeJS.ProcessEnv = process.env): LighthouseLocation | null {
  const fromEnv = env['TIRNO_LIGHTHOUSE'];
  if (fromEnv) {
    // 파일이면 그대로, 디렉터리면 그 아래 node_modules/lighthouse
    if (fs.existsSync(fromEnv) && fs.statSync(fromEnv).isFile()) return { entry: fromEnv, source: 'env' };
    const e = entryUnder(fromEnv);
    if (e) return { entry: e, source: 'env' };
    return null;   // 명시했는데 틀렸으면 다음 후보로 넘어가지 않는다 — chrome-finder 와 같은 규칙
  }
  const plugin = entryUnder(pluginRoot());
  if (plugin) return { entry: plugin, source: 'plugin' };
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const g = entryUnder(path.dirname(globalRoot));
    if (g) return { entry: g, source: 'global' };
  } catch { /* npm 이 없다 */ }
  // 개발·스모크 — 이 파일이 레포의 dist/ 아래에 있을 때만
  try {
    const here = fileURLToPath(import.meta.url);
    const repo = path.resolve(path.dirname(here), '..', '..');
    const r = entryUnder(repo);
    if (r) return { entry: r, source: 'repo' };
  } catch { /* 번들 안에서는 경로가 없다 */ }
  return null;
}

export const INSTALL_HINT = [
  'lighthouse is not bundled with tirno (it alone was half the binary).',
  `install it once:  tirno plugin install audit     (runs npm into ${PLUGIN_DIR_NAME})`,
  'or point at one:  TIRNO_LIGHTHOUSE=/path/to/dir-with-node_modules  ·  npm i -g lighthouse',
].join('\n');

/** 계산된 경로로 import — 번들러가 따라오지 못한다 */
export async function loadLighthouse(): Promise<Record<string, unknown>> {
  const found = locateLighthouse();
  if (!found) throw new Error(INSTALL_HINT);
  return await import(pathToFileURL(found.entry).href) as Record<string, unknown>;
}

/** `npm install --prefix ~/.tirno/plugins/audit lighthouse` */
export function installLighthouse(version = '12'): { dir: string; output: string } {
  const dir = pluginRoot();
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'package.json'))) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tirno-plugin-audit', private: true }, null, 2));
  const output = execFileSync('npm', ['install', '--no-audit', '--no-fund', '--prefix', dir, `lighthouse@${version}`], { encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { dir, output };
}
