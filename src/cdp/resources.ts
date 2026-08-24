import path from 'node:path';
import type { CDPSession } from 'puppeteer-core';

/**
 * 이 세션이 이미 받은 리소스의 **바이트**.
 *
 * "본 것을 적어둔다" 가 이 도구의 설계인데, 본 리소스의 본문만 꺼낼 방법이 없었다.
 * 픽셀까지 데려다주고 실제 산출물은 툴 바깥에서 다시 만들어야 했다 — `eval` 로 URL 을
 * 긁어 `curl` 로 받는 식이다 (#136). 그 우회는 세 가지를 깨뜨린다:
 *
 * 1. **브라우저가 이미 가진 상태를 버린다.** 쿠키·Referer·UA 를 curl 쪽에서 손으로
 *    재구성해야 하고, Referer 를 안 붙이면 CDN 이 막는다. 로그인이 필요한 리소스면
 *    세션까지 옮겨야 하는데, 그것은 tirno 의 세션 격리를 정면으로 무너뜨린다.
 * 2. **서명 URL 이 휘발한다.** 수집 시점과 다운로드 시점 사이에 만료 레이스가 있다.
 *    브라우저가 이미 받아둔 응답 본문을 쓰면 없는 문제다.
 * 3. `eval` 로 DOM 을 긁는 것은 페이지 구조에 의존한다. 네트워크 레이어는 그런 게 없다.
 *
 * 그래서 1차 경로는 **렌더러가 들고 있는 그 응답**(`Page.getResourceContent`)이다.
 * 명령마다 CDP 를 붙였다 끊는 구조에서도 되는 이유가 이것이다 — 요청 시점에 듣고
 * 있을 필요가 없다. 캐시에서 밀려난 것만 브라우저에게 다시 받아달라고 한다
 * (그쪽도 쿠키·Referer·UA 가 전부 브라우저 것이다 — `fetchBody` 주석 참고).
 */

export interface PageResource {
  url: string;
  type: string;
  mimeType: string;
  /** 렌더러가 보고한 크기. data: URI 나 미상이면 0 이다. */
  contentSize: number;
  frameId: string;
  /** 메인 프레임이 아니면 그 프레임 URL. */
  frameUrl: string;
}

interface ResourceTreeFrame {
  frame: { id: string; url: string };
  resources: Array<{ url: string; type: string; mimeType: string; contentSize?: number }>;
  childFrames?: ResourceTreeFrame[];
}

/** 프레임 트리를 평평하게. iframe 안의 것도 이 세션이 받은 것이다. */
export function flattenResourceTree(root: ResourceTreeFrame): PageResource[] {
  const out: PageResource[] = [];
  const walk = (node: ResourceTreeFrame): void => {
    for (const r of node.resources ?? []) {
      out.push({
        url: r.url,
        type: r.type,
        mimeType: r.mimeType,
        contentSize: r.contentSize ?? 0,
        frameId: node.frame.id,
        frameUrl: node.frame.url,
      });
    }
    for (const child of node.childFrames ?? []) walk(child);
  };
  walk(root);
  return out;
}

export async function listResources(cdp: CDPSession): Promise<PageResource[]> {
  // Page 도메인을 켜지 않으면 getResourceContent 가 "Agent is not enabled" 로 죽는다(실측).
  await cdp.send('Page.enable');
  const tree = await cdp.send('Page.getResourceTree') as unknown as { frameTree: ResourceTreeFrame };
  return flattenResourceTree(tree.frameTree);
}

/**
 * 패턴 매칭. `*` 와 `?` 만 있고, **양끝은 열려 있다** — `scontent*.jpg` 가
 * `https://scontent-xyz.cdninstagram.com/…/foo.jpg?token=…` 에 걸려야 쓸모가 있다.
 * 패턴에 와일드카드가 없으면 그냥 부분 문자열이다.
 */
export function matchesFilter(url: string, pattern: string): boolean {
  if (!pattern) return true;
  if (!/[*?]/.test(pattern)) return url.includes(pattern);
  const re = new RegExp(
    pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.'),
  );
  return re.test(url);
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'application/json': '.json',
  'text/html': '.html',
  'text/css': '.css',
  'text/javascript': '.js',
  'application/javascript': '.js',
};

/**
 * 저장 이름. URL 의 basename 을 쓰되 **쿼리는 뗀다** — 서명 URL 의 쿼리는 파일 이름이
 * 아니라 만료 토큰이고, 파일 시스템에 그대로 못 쓰는 문자가 들어 있다.
 *
 * 이름이 겹치면 뒤에 번호를 붙인다. 덮어쓰기는 하지 않는다 — 13장을 받으려고 부른
 * 명령이 1장을 남기는 것이 이 자리의 조용한 실패 형태다.
 */
export function fileNameFor(url: string, mimeType: string, taken: Set<string>): string {
  let base: string;
  try {
    base = path.posix.basename(new URL(url).pathname);
  } catch {
    base = '';
  }
  base = base.replace(/[^\w.@ +-]/g, '_').replace(/^\.+/, '');
  if (!base) base = 'resource';

  const wanted = EXTENSION_BY_MIME[mimeType.split(';')[0]!.trim().toLowerCase()];
  if (wanted && path.extname(base).toLowerCase() !== wanted) base += wanted;

  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

export type BodySource = 'cache' | 're-fetch';

export interface Body {
  bytes: Buffer;
  source: BodySource;
}

/**
 * 본문을 가져온다. 렌더러가 들고 있으면 **그것이 정본**이다 — 브라우저가 실제로 받은
 * 바이트이고, 서명 URL 의 만료와 무관하다.
 *
 * 밀려났으면 브라우저에게 다시 받아달라고 한다. 페이지 안의 `fetch` 로는 안 된다 —
 * 자산은 대개 다른 오리진(CDN)에 있고 CORS 가 막는다(실측: en.wikipedia.org 문서에서
 * upload.wikimedia.org 이미지를 fetch 하면 "Failed to fetch"). `Network.loadNetworkResource`
 * 는 프레임 컨텍스트에서 브라우저가 직접 받으므로 CORS 를 지나지 않고, 쿠키·Referer·UA 가
 * 전부 브라우저의 것이다. 툴 바깥의 curl 과 다른 점이 정확히 이것이다 — 재구성할 것이 없다.
 */
export async function fetchBody(cdp: CDPSession, r: PageResource): Promise<Body> {
  try {
    const res = await cdp.send('Page.getResourceContent', { frameId: r.frameId, url: r.url }) as unknown as
      { content: string; base64Encoded: boolean };
    return {
      bytes: Buffer.from(res.content, res.base64Encoded ? 'base64' : 'utf-8'),
      source: 'cache',
    };
  } catch {
    return { bytes: await loadOverNetwork(cdp, r), source: 're-fetch' };
  }
}

async function loadOverNetwork(cdp: CDPSession, r: PageResource): Promise<Buffer> {
  const { resource } = await cdp.send('Network.loadNetworkResource', {
    frameId: r.frameId,
    url: r.url,
    options: { disableCache: false, includeCredentials: true },
  }) as unknown as {
    resource: { success: boolean; netError?: number; netErrorName?: string; httpStatusCode?: number; stream?: string };
  };

  if (!resource.success || !resource.stream) {
    throw new Error(resource.netErrorName ?? `HTTP ${resource.httpStatusCode ?? '?'} and no body`);
  }

  const chunks: Buffer[] = [];
  try {
    for (;;) {
      const chunk = await cdp.send('IO.read', { handle: resource.stream }) as unknown as
        { data?: string; base64Encoded?: boolean; eof: boolean };
      if (chunk.data) chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf-8'));
      if (chunk.eof) break;
    }
  } finally {
    // 핸들은 브라우저 쪽 자원이다. 중간에 실패해도 놓지 않으면 세션에 쌓인다.
    await cdp.send('IO.close', { handle: resource.stream }).catch(() => { /* 이미 닫혔다 */ });
  }
  return Buffer.concat(chunks);
}
