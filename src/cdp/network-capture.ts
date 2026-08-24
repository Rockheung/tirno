import type { CDPSession, Page } from 'puppeteer-core';

/**
 * 한 창(window) 동안의 네트워크 요청.
 *
 * `network` 와 `net export` 가 같은 캡처를 쓴다 — 목록에 보이는 것과 HAR 에 실리는 것이
 * 다르면 둘 중 하나는 거짓말이 된다.
 */

export interface CapturedRequest {
  id: number;
  requestId: string;
  url: string;
  method: string;
  status: number;
  statusText: string;
  type: string;
  protocol: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string;
  mimeType?: string;
  /** epoch seconds. `Network.requestWillBeSent` 의 wallTime. */
  wallTime: number;
  /** ms. 모르면 -1 — HAR 의 규약과 같다. */
  timings: { send: number; wait: number; receive: number };
  /** 전송된 바이트(헤더 포함). 모르면 -1. */
  encodedDataLength: number;
  /** 브라우저 캐시에서 나왔다. */
  fromCache: boolean;
}

interface RawTiming {
  requestTime: number;
  sendStart: number;
  sendEnd: number;
  receiveHeadersEnd: number;
}

/**
 * `reload: false` 면 리로드하지 않는다. 리로드는 **현재 상태를 버리고 다시 받는 일**이라,
 * 캐러셀을 7번 넘겨둔 페이지에서 부르면 1번으로 돌아간다 (#136). 대신 그 창 동안
 * 페이지가 스스로 내는 요청만 잡힌다 — 이미 받아둔 것은 `net ls` 쪽이다.
 */
export async function captureRequests(
  cdp: CDPSession,
  page: Page,
  opts: { reload: boolean; ms: number },
): Promise<CapturedRequest[]> {
  await cdp.send('Network.enable');

  const pending = new Map<string, Partial<CapturedRequest>>();
  const completed: CapturedRequest[] = [];
  const timings = new Map<string, RawTiming>();

  cdp.on('Network.requestWillBeSent', (params) => {
    const p = params as unknown as {
      requestId: string; wallTime: number;
      request: { url: string; method: string; headers: Record<string, string>; postData?: string };
      type: string;
    };
    pending.set(p.requestId, {
      requestId: p.requestId,
      url: p.request.url,
      method: p.request.method,
      type: p.type,
      requestHeaders: p.request.headers,
      postData: p.request.postData,
      wallTime: p.wallTime,
    });
  });

  cdp.on('Network.responseReceived', (params) => {
    const p = params as unknown as {
      requestId: string;
      response: {
        status: number; statusText: string; headers: Record<string, string>;
        mimeType: string; protocol?: string; fromDiskCache?: boolean;
        fromServiceWorker?: boolean; timing?: RawTiming;
      };
      type: string;
    };
    const partial = pending.get(p.requestId);
    if (!partial) return;
    if (p.response.timing) timings.set(p.requestId, p.response.timing);
    completed.push({
      id: completed.length,
      requestId: partial.requestId!,
      url: partial.url!,
      method: partial.method!,
      status: p.response.status,
      statusText: p.response.statusText ?? '',
      type: p.type,
      protocol: p.response.protocol ?? '',
      requestHeaders: partial.requestHeaders,
      responseHeaders: p.response.headers,
      mimeType: p.response.mimeType,
      postData: partial.postData,
      wallTime: partial.wallTime ?? 0,
      timings: splitTimings(p.response.timing),
      encodedDataLength: -1,
      fromCache: !!p.response.fromDiskCache,
    });
    pending.delete(p.requestId);
  });

  // 본문 크기와 receive 구간은 응답이 끝나야 안다.
  cdp.on('Network.loadingFinished', (params) => {
    const p = params as unknown as { requestId: string; timestamp: number; encodedDataLength: number };
    const entry = completed.find(c => c.requestId === p.requestId);
    if (!entry) return;
    entry.encodedDataLength = p.encodedDataLength;
    const t = timings.get(p.requestId);
    if (t && t.receiveHeadersEnd >= 0) {
      const total = (p.timestamp - t.requestTime) * 1000;
      entry.timings.receive = Math.max(0, round3(total - t.receiveHeadersEnd));
    }
  });

  if (opts.reload) {
    await page.reload({ waitUntil: 'networkidle2' }).catch(() => { /* 타임아웃도 관측이다 */ });
  } else {
    await new Promise(r => setTimeout(r, opts.ms));
  }

  return completed;
}

/**
 * CDP 의 타이밍은 요청 시작으로부터의 오프셋이고, HAR 은 구간의 길이다.
 * 모르는 구간은 0 이 아니라 **-1** 이다 — 0 은 "즉시 끝났다" 이고 -1 이 "모른다" 다.
 */
function splitTimings(t: RawTiming | undefined): { send: number; wait: number; receive: number } {
  if (!t || t.sendStart < 0) return { send: -1, wait: -1, receive: -1 };
  return {
    send: Math.max(0, round3(t.sendEnd - t.sendStart)),
    wait: Math.max(0, round3(t.receiveHeadersEnd - t.sendEnd)),
    receive: -1, // loadingFinished 가 채운다
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
