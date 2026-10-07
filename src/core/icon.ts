import fs from 'node:fs';
import path from 'node:path';
import { underRoot } from './paths.js';
import { ICNS_BASE64 } from './icon-data.js';

/**
 * 받아온 번들에 tirno 아이콘을 입힌다 (macOS).
 *
 * **왜 필요한가.** tirno 가 띄운 창은 독에서 사용자의 평소 크롬과 생김새가 같다. 어느
 * 창이 에이전트의 것인지 눈으로 구분할 수 없으면 사람이 그 창에 로그인하고, 에이전트가
 * 쓰는 프로필에 자기 세션을 남긴다. 구글도 같은 문제를 Chrome for Testing 의 노란 TEST
 * 리본으로 풀었다 — 그 자리에 tirno 리본을 둔다.
 *
 * **tirno 가 받은 번들만 건드린다.** `tirno chrome set` 으로 가리킨 브라우저나
 * /Applications 의 크롬은 우리 것이 아니다. 거기 아이콘을 바꾸면 사용자가 평소 쓰는
 * 크롬이 같이 바뀐다 — 그래서 `~/.tirno/chrome/` 아래가 아니면 손대지 않고 왜 안 했는지를
 * 돌려준다. 이 판정은 호출하는 쪽의 선의가 아니라 여기서 건다.
 *
 * **서명은 깨지지 않는다.** CfT 번들은 adhoc·linker-signed 라 `Sealed Resources=none`
 * 이고 Info.plist 도 bound 가 아니다. 즉 `Contents/Resources/` 의 파일은 서명이 봉인하지
 * 않는다 — 교체 전후로 `codesign --verify` 의 출력이 같다(실측). 번들을 통째로 복사해
 * 재서명하는 길도 있었지만 그쪽은 크롬의 키체인 접근과 자동 업데이트를 함께 잃는다.
 */

export type BrandOutcome =
  | { done: true; icns: string }
  | { done: false; reason: 'not-macos' | 'not-a-bundle' | 'not-ours' | 'write-failed'; detail?: string };

export interface BrandOptions {
  /** 우리가 받은 것으로 인정할 뿌리. 기본값은 `~/.tirno/chrome`. */
  root?: string;
  /** 테스트가 darwin 아닌 CI 에서도 쓰기 경로를 증명할 수 있게 뚫어 둔다. */
  platform?: NodeJS.Platform;
}

/** `.../X.app/Contents/MacOS/<exe>` → `.../X.app/Contents/Resources`. 그 모양이 아니면 null. */
export function bundleResources(binary: string): string | null {
  const macos = path.dirname(binary);
  const contents = path.dirname(macos);
  const app = path.dirname(contents);
  if (path.basename(macos) !== 'MacOS') return null;
  if (path.basename(contents) !== 'Contents') return null;
  if (!path.basename(app).endsWith('.app')) return null;
  return path.join(contents, 'Resources');
}

/**
 * 어느 파일을 갈아야 하는지는 번들이 안다 — `app.icns` 는 크롬의 관례일 뿐이다.
 * CFBundleIconFile 은 확장자를 빼고 적히는 것이 허용돼 있어서 붙여 준다.
 */
export function iconFileName(resources: string): string {
  try {
    const plist = fs.readFileSync(path.join(path.dirname(resources), 'Info.plist'), 'utf-8');
    const m = /<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
    if (m?.[1]) {
      const name = m[1].trim();
      return name.toLowerCase().endsWith('.icns') ? name : `${name}.icns`;
    }
  } catch { /* 못 읽으면 관례로 간다 — 그래도 안 맞으면 아이콘이 안 바뀔 뿐이다 */ }
  return 'app.icns';
}

/** 바이너리에 박아 둔 .icns 바이트. */
export function icnsBytes(): Buffer {
  return Buffer.from(ICNS_BASE64, 'base64');
}

export function brandBundle(binary: string, opts: BrandOptions = {}): BrandOutcome {
  if ((opts.platform ?? process.platform) !== 'darwin') return { done: false, reason: 'not-macos' };

  const resources = bundleResources(binary);
  if (!resources) return { done: false, reason: 'not-a-bundle' };

  const root = opts.root ?? underRoot('chrome');
  if (!isUnder(root, binary)) return { done: false, reason: 'not-ours', detail: root };

  const target = path.join(resources, iconFileName(resources));
  try {
    fs.writeFileSync(target, icnsBytes());
    // 독과 Finder 는 번들의 mtime 을 보고 아이콘 캐시를 무를지 정한다. 안 건드리면
    // 이미 한 번 뜬 적 있는 번들이 옛 아이콘을 계속 쓴다.
    const now = new Date();
    fs.utimesSync(path.dirname(path.dirname(resources)), now, now);
    return { done: true, icns: target };
  } catch (e) {
    return { done: false, reason: 'write-failed', detail: (e as Error).message };
  }
}

function isUnder(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
