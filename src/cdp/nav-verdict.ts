/**
 * `nav` 가 "도달했다" 와 "의도한 페이지에 도달했다" 를 가른다 (#189).
 *
 * `page.goto` 가 돌아왔다는 것은 문서가 커밋됐다는 것까지다. 404 문서도, 500 문서도,
 * 크롬 자체의 에러 페이지도 커밋된다. 그 셋을 `✓` 로 내면 호출자는 다음 명령으로 간다 —
 * Not Found 페이지의 a11y 트리를 찍고 그 안의 링크를 누른다.
 */

export interface NavFacts {
  url: string;
  /** puppeteer 가 준 응답 상태. 응답이 없으면 0 */
  status: number;
  /** 커밋된 뒤 페이지가 보고하는 URL */
  finalUrl: string;
  elapsed: number;
  strict: boolean;
}

export interface NavVerdict {
  /** ok → exit 0 · warn → exit 0 + stderr 경고 · fail → exit 1 */
  level: 'ok' | 'warn' | 'fail';
  line: string;
  /** warn/fail 일 때 한 줄 더 */
  note?: string;
}

/** http(s) 가 아니면 상태 코드라는 것이 없다 — `file:` · `data:` · `about:` */
function hasHttpStatus(url: string): boolean {
  return /^https?:/i.test(url);
}

export function judgeNavigation(f: NavFacts): NavVerdict {
  const line = `${f.url} (${f.status || 'no status'}, ${f.elapsed}ms)`;

  // 크롬이 자기 에러 페이지를 커밋했다 — DNS 실패·연결 거부 중 goto 가 던지지 않는 부류
  if (/^chrome-error:/.test(f.finalUrl)) {
    return { level: 'fail', line, note: `chrome showed its own error page (${f.finalUrl}) — the site did not answer` };
  }

  if (f.status === 0) {
    if (!hasHttpStatus(f.url)) return { level: 'ok', line };
    return {
      level: 'fail', line,
      note: 'no response for this navigation — the page navigated itself away before the document committed, or the redirect chain broke. Read `tirno eval location.href` to see where it ended up',
    };
  }

  const nonOk = f.status < 200 || f.status >= 300;
  if (!nonOk) return { level: 'ok', line };
  if (f.strict) return { level: 'fail', line, note: `strict: non-2xx (${f.status})` };
  return {
    level: 'warn', line,
    note: `non-2xx — the page loaded but the server said ${f.status}. What you snapshot next is that error page. --strict makes this exit 1`,
  };
}
