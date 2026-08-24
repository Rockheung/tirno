import type { CapturedRequest } from '../cdp/network-capture.js';

/**
 * HAR 1.2 직렬화기.
 *
 * `network --show <id> --json` 이 이미 헤더·상태·mime·본문을 다 준다. 없던 것은
 * **세션 전체를 하나의 산출물로 넘길 형식**이었다 (#140). HAR 은 이 영역의 유일한
 * 상호운용 포맷이라, 한 파일이 나오면 DevTools Network 패널에 그대로 끌어다 놓고,
 * CI 아티팩트로 붙이고, 다른 도구에 먹일 수 있다. 즉 없던 것은 데이터가 아니라
 * 직렬화기뿐이었다.
 *
 * 스펙에서 조심할 자리 둘:
 *
 * - 모르는 값은 **-1** 이다. 0 은 "0바이트/0ms" 라는 주장이고, 그것은 모른다와 다르다.
 * - `time` 은 -1 이 아닌 timings 구간의 합이어야 한다. 안 맞으면 DevTools 가 항목의
 *   폭포(waterfall)를 그리지 못한다.
 */

export interface HarBody {
  /** 응답 본문. 없으면 content.text 를 아예 안 싣는다. */
  text: string;
  /** base64 로 실었나. HAR 은 `encoding: "base64"` 로 표시한다. */
  base64: boolean;
}

export interface HarOptions {
  pageUrl: string;
  pageTitle: string;
  /** epoch ms. 호출자가 넘긴다 — 직렬화기는 시계를 읽지 않는다(테스트가 고정된다). */
  startedAt: number;
  version: string;
  bodies?: Map<string, HarBody>;
}

function headerList(h: Record<string, string> | undefined): Array<{ name: string; value: string }> {
  return Object.entries(h ?? {}).map(([name, value]) => ({ name, value: String(value) }));
}

function queryList(url: string): Array<{ name: string; value: string }> {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

/** -1 인 구간은 합에서 뺀다. 전부 모르면 time 도 -1 이다. */
function totalTime(t: { send: number; wait: number; receive: number }): number {
  const known = [t.send, t.wait, t.receive].filter(n => n >= 0);
  return known.length === 0 ? -1 : Math.round(known.reduce((a, b) => a + b, 0) * 1000) / 1000;
}

export function toHar(requests: CapturedRequest[], opts: HarOptions): unknown {
  const pageId = 'page_1';
  const entries = requests.map(r => {
    const body = opts.bodies?.get(r.requestId);
    const content: Record<string, unknown> = {
      // size 는 압축을 푼 본문 크기다. 본문이 없으면 주장하지 않는다.
      size: body ? Buffer.byteLength(body.text, body.base64 ? 'base64' : 'utf-8') : -1,
      mimeType: r.mimeType ?? '',
    };
    if (body) {
      content.text = body.text;
      if (body.base64) content.encoding = 'base64';
    }

    const request: Record<string, unknown> = {
      method: r.method,
      url: r.url,
      httpVersion: r.protocol || 'HTTP/1.1',
      cookies: [],
      headers: headerList(r.requestHeaders),
      queryString: queryList(r.url),
      headersSize: -1,
      bodySize: r.postData === undefined ? -1 : Buffer.byteLength(r.postData),
    };
    if (r.postData !== undefined) {
      request.postData = {
        mimeType: r.requestHeaders?.['content-type'] ?? r.requestHeaders?.['Content-Type'] ?? '',
        text: r.postData,
      };
    }

    return {
      pageref: pageId,
      startedDateTime: new Date(r.wallTime * 1000).toISOString(),
      time: totalTime(r.timings),
      request,
      response: {
        status: r.status,
        statusText: r.statusText,
        httpVersion: r.protocol || 'HTTP/1.1',
        cookies: [],
        headers: headerList(r.responseHeaders),
        content,
        redirectURL: r.responseHeaders?.location ?? r.responseHeaders?.Location ?? '',
        headersSize: -1,
        bodySize: r.encodedDataLength,
      },
      // 브라우저 캐시에서 나온 것은 그렇게 적는다 — 전송량 0 을 "빠른 서버" 로 읽으면 안 된다.
      cache: r.fromCache ? { afterRequest: null } : {},
      timings: r.timings,
      _tirno: { resourceType: r.type, fromCache: r.fromCache },
    };
  });

  return {
    log: {
      version: '1.2',
      creator: { name: 'tirno', version: opts.version },
      pages: [{
        startedDateTime: new Date(opts.startedAt).toISOString(),
        id: pageId,
        title: opts.pageTitle || opts.pageUrl,
        // 이 값들을 재려면 페이지를 리로드해야 한다. 리로드는 상태를 버리는 일이라
        // export 가 할 짓이 아니다 (#136) — 그래서 모른다고 적는다.
        pageTimings: { onContentLoad: -1, onLoad: -1 },
      }],
      entries,
    },
  };
}
