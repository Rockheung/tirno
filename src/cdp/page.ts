/**
 * Page — 탭 하나와의 대화, CDP 위에 직접 (#182).
 *
 * tirno 가 실제로 부르는 메서드만 있다. puppeteer 를 다시 만들지 않는다 — `ElementHandle`
 * 같은 일반 추상 대신 `backendNodeId` 숫자를 돌리고(ref store 가 이미 그렇게 산다),
 * 대기 의미론은 puppeteer 의 것을 출처를 적고 베낀다(새로 발명하지 않는다).
 *
 * 세션은 **연결이 살아 있는 동안** 유지된다. 에뮬레이션·헤더·권한 오버라이드는 세션에
 * 묶이므로, connect 마다 대장에서 재적용하는 기존 모델이 그대로 맞는다.
 */
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Protocol } from 'devtools-protocol';
import type { CdpSession } from './client.js';
import type { Browser } from './browser.js';
import { Keyboard, Mouse } from './input.js';
import type { Device } from './known-devices.js';

export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';

export interface NavigationOptions {
  waitUntil?: WaitUntil;
  timeout?: number;
}

/** 문서 응답 — `nav` 가 상태 코드를 읽는다 */
export interface HttpResponse {
  status(): number;
  url(): string;
  ok(): boolean;
}

export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  isLandscape?: boolean;
}

export interface ScreenshotOptions {
  type?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  fullPage?: boolean;
  optimizeForSpeed?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
}

export interface ConsoleLocation { url?: string; lineNumber?: number; columnNumber?: number }

/** `Runtime.consoleAPICalled` 를 puppeteer 의 ConsoleMessage 모양으로 */
export class ConsoleMessage {
  constructor(private readonly ev: Protocol.Runtime.ConsoleAPICalledEvent) {}
  type(): string {
    return this.ev.type === 'warning' ? 'warn' : this.ev.type;
  }
  text(): string {
    return this.ev.args.map(describeRemote).join(' ');
  }
  args(): string[] {
    return this.ev.args.map(describeRemote);
  }
  location(): ConsoleLocation {
    const f = this.ev.stackTrace?.callFrames[0];
    return f ? { url: f.url, lineNumber: f.lineNumber, columnNumber: f.columnNumber } : {};
  }
  stackTrace(): ConsoleLocation[] {
    return (this.ev.stackTrace?.callFrames ?? []).map(f => ({ url: f.url, lineNumber: f.lineNumber, columnNumber: f.columnNumber }));
  }
}

function describeRemote(o: Protocol.Runtime.RemoteObject): string {
  if (o.type === 'string') return String(o.value);
  if (o.value !== undefined) return String(o.value);
  if (o.unserializableValue !== undefined) return o.unserializableValue;
  return o.description ?? o.type;
}

export class Dialog {
  constructor(private readonly session: CdpSession, readonly type: string, readonly message: string) {}
  async accept(text?: string): Promise<void> {
    await this.session.send('Page.handleJavaScriptDialog', { accept: true, ...(text !== undefined ? { promptText: text } : {}) });
  }
  async dismiss(): Promise<void> {
    await this.session.send('Page.handleJavaScriptDialog', { accept: false });
  }
}

/** 요소 하나 — `objectId`(이 세션에서만 유효) 와 `backendNodeId`(문서가 살아 있는 동안) */
export class ElementHandle {
  constructor(readonly page: Page, private readonly objectId: string, private readonly backendId: number) {}

  backendNodeId(): number {
    return this.backendId;
  }

  remoteObject(): { objectId: string } {
    return { objectId: this.objectId };
  }

  /** border 상자. 렌더되지 않았으면 null. */
  async boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    try {
      const { model } = await this.page.session.send('DOM.getBoxModel', { backendNodeId: this.backendId });
      const q = model.border;
      const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
      return { x: Math.min(...xs), y: Math.min(...ys), width: model.width, height: model.height };
    } catch {
      return null;
    }
  }

  evaluate<Args extends unknown[], R>(fn: (el: Element, ...args: Args) => R, ...args: Args): Promise<Awaited<R>>;
  evaluate<T = unknown>(fn: string, ...args: unknown[]): Promise<T>;
  async evaluate(fn: string | ((el: never, ...args: never[]) => unknown), ...args: unknown[]): Promise<unknown> {
    const r = await this.page.session.send('Runtime.callFunctionOn', {
      objectId: this.objectId,
      functionDeclaration: typeof fn === 'string' ? `function(){ return (${fn}).apply(this, arguments) }` : String(fn),
      arguments: [{ objectId: this.objectId }, ...args.map(v => ({ value: v }))],
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw evaluationError(r.exceptionDetails);
    return r.result.value;
  }

  /**
   * 누를 점 — 상자를 **뷰포트로 잘라낸** 뒤의 중심. 뷰포트보다 큰 요소는 상자 중심이
   * 화면 밖이고, 거기로 보낸 마우스 이벤트는 아무 데도 닿지 않으면서 "Clicked" 가 됐다
   * (실측: 3000px 버튼). puppeteer 는 getContentQuads 를 뷰포트로 클립했다 — 같은 뜻이다.
   */
  private async centre(): Promise<{ x: number; y: number }> {
    await this.page.session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: this.backendId }).catch(() => {});
    const box = await this.boundingBox();
    if (!box) throw new Error('Node is either not clickable or not an Element');
    const m = await this.page.session.send('Page.getLayoutMetrics');
    const vw = m.cssLayoutViewport.clientWidth, vh = m.cssLayoutViewport.clientHeight;
    const x0 = Math.max(box.x, 0), y0 = Math.max(box.y, 0);
    const x1 = Math.min(box.x + box.width, vw), y1 = Math.min(box.y + box.height, vh);
    if (x1 <= x0 || y1 <= y0) throw new Error('Node is outside of the viewport even after scrolling into view');
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  }

  /** 실제 마우스 — 스크롤해서 보이게 한 뒤 중심을 누른다 (puppeteer ElementHandle.click) */
  async click(opts: { count?: number; delay?: number } = {}): Promise<void> {
    const { x, y } = await this.centre();
    await this.page.mouse.click(x, y, opts);
  }

  async hover(): Promise<void> {
    const { x, y } = await this.centre();
    await this.page.mouse.move(x, y);
  }

  /** 포커스를 주고 친다 */
  async type(text: string, opts: { delay?: number } = {}): Promise<void> {
    await this.page.session.send('DOM.focus', { backendNodeId: this.backendId });
    await this.page.keyboard.type(text, opts);
  }

  async uploadFile(...files: string[]): Promise<void> {
    await this.page.session.send('DOM.setFileInputFiles', {
      files: files.map(f => path.resolve(f)),
      backendNodeId: this.backendId,
    });
  }
}

/** 열린 shadow root 를 관통하는 querySelector — puppeteer 의 `pierce/` 와 같은 뜻 */
const PIERCE_QUERY = `(selector) => {
  const found = (root) => {
    const direct = root.querySelector(selector);
    if (direct) return direct;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.currentNode; n; n = walker.nextNode()) {
      if (n.shadowRoot) { const hit = found(n.shadowRoot); if (hit) return hit; }
    }
    return null;
  };
  return found(document);
}`;

interface Waiter<T> { promise: Promise<T>; cancel(): void }

export class Page {
  readonly keyboard: Keyboard;
  readonly mouse: Mouse;
  readonly tracing: Tracing;
  private readonly emitter = new EventEmitter();
  private currentUrl = '';
  private mainFrameId = '';
  /** loaderId → 문서 응답 상태 (nav 의 status) */
  private readonly docResponses = new Map<string, { status: number; url: string }>();
  /** 진행 중 요청 — waitForNetworkIdle 이 센다 */
  private readonly inflight = new Set<string>();
  private lastActivity = Date.now();

  private constructor(readonly browser: Browser, readonly targetId: string, readonly session: CdpSession) {
    this.keyboard = new Keyboard(session);
    this.mouse = new Mouse(session, this.keyboard);
    this.tracing = new Tracing(session);
    this.emitter.setMaxListeners(0);
  }

  /** @internal 타깃에 붙고 필요한 도메인을 켠다 */
  static async attach(browser: Browser, targetId: string, initialUrl: string): Promise<Page> {
    const session = await browser.connection.attach(targetId);
    const page = new Page(browser, targetId, session);
    page.currentUrl = initialUrl;
    page.wire();
    // Page: 네비게이션 이벤트·다이얼로그·스크린샷. Runtime: evaluate·console. Network: 문서
    // 상태 코드·헤더 오버라이드·idle 판정. puppeteer 도 같은 셋을 처음에 켠다.
    const [tree] = await Promise.all([
      session.send('Page.getFrameTree'),
      session.send('Page.enable'),
      session.send('Runtime.enable'),
      session.send('Network.enable'),
    ]);
    page.mainFrameId = tree.frameTree.frame.id;
    if (tree.frameTree.frame.url) page.currentUrl = tree.frameTree.frame.url;
    return page;
  }

  private wire(): void {
    const s = this.session;
    s.on('Page.frameNavigated', ({ frame }) => {
      if (!frame.parentId) { this.mainFrameId = frame.id; this.currentUrl = frame.url + (frame.urlFragment ?? ''); }
    });
    s.on('Page.navigatedWithinDocument', ({ frameId, url }) => {
      if (frameId === this.mainFrameId) this.currentUrl = url;
    });
    s.on('Network.requestWillBeSent', (e) => {
      this.inflight.add(e.requestId);
      this.lastActivity = Date.now();
    });
    const done = (e: { requestId: string }) => { this.inflight.delete(e.requestId); this.lastActivity = Date.now(); };
    s.on('Network.loadingFinished', done);
    s.on('Network.loadingFailed', done);
    s.on('Network.responseReceived', (e) => {
      if (e.type === 'Document' && e.frameId === this.mainFrameId) {
        this.docResponses.set(e.loaderId, { status: e.response.status, url: e.response.url });
      }
    });
    s.on('Runtime.consoleAPICalled', (e) => this.emitter.emit('console', new ConsoleMessage(e)));
    s.on('Runtime.exceptionThrown', (e) => this.emitter.emit('pageerror', new Error(e.exceptionDetails.exception?.description ?? e.exceptionDetails.text)));
    s.on('Page.frameNavigated', ({ frame }) => { if (!frame.parentId) this.emitter.emit('navigated', frame.url); });
    s.on('Page.javascriptDialogOpening', (e) => this.emitter.emit('dialog', new Dialog(s, e.type, e.message)));
  }

  // ------------------------------------------------------------- events

  on(event: 'console', handler: (m: ConsoleMessage) => void): this;
  on(event: 'dialog', handler: (d: Dialog) => void): this;
  on(event: 'pageerror', handler: (e: Error) => void): this;
  on(event: 'navigated', handler: (url: string) => void): this;
  on(event: string, handler: (...a: never[]) => void): this {
    this.emitter.on(event, handler as (...a: unknown[]) => void);
    return this;
  }

  off(event: string, handler: (...a: never[]) => void): this {
    this.emitter.off(event, handler as (...a: unknown[]) => void);
    return this;
  }

  removeAllListeners(event?: string): this {
    this.emitter.removeAllListeners(event);
    return this;
  }

  // ------------------------------------------------------------- basics

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return this.evaluate<string>('document.title');
  }

  /** 따로 붙인 세션 — 임시 작업용. detach 하면 그 세션이 건 오버라이드도 사라진다. */
  createCDPSession(): Promise<CdpSession> {
    return this.browser.connection.attach(this.targetId);
  }

  async bringToFront(): Promise<void> {
    await this.session.send('Page.bringToFront');
  }

  async close(): Promise<void> {
    await this.browser.connection.send('Target.closeTarget', { targetId: this.targetId });
    this.browser.forgetPage(this.targetId);
  }

  /**
   * 함수면 `(fn)(args…)` 로, 문자열이면 그대로 식으로 평가한다. 인자는 JSON 으로 실린다 —
   * puppeteer 와 같은 제약(직렬화 가능한 값만). 결과도 값으로 돌아온다(`returnByValue`).
   */
  evaluate<Args extends unknown[], R>(fn: (...args: Args) => R, ...args: Args): Promise<Awaited<R>>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  async evaluate(fn: string | ((...args: never[]) => unknown), ...args: unknown[]): Promise<unknown> {
    const expression = typeof fn === 'string'
      ? fn
      : `(${fn})(${args.map(a => a === undefined ? 'undefined' : JSON.stringify(a)).join(',')})`;
    const r = await this.session.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.exceptionDetails) throw evaluationError(r.exceptionDetails);
    return r.result.value;
  }

  /** 새 문서마다 다른 스크립트보다 먼저 돈다 */
  async evaluateOnNewDocument(source: string | (() => unknown)): Promise<void> {
    await this.session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: typeof source === 'string' ? source : `(${source})()`,
    });
  }

  // ---------------------------------------------------------- selectors

  /** 셀렉터 하나. `pierce/` 접두사면 열린 shadow root 안까지. 없으면 null. */
  async $(selector: string): Promise<ElementHandle | null> {
    const pierce = selector.startsWith('pierce/');
    const sel = pierce ? selector.slice('pierce/'.length) : selector;
    const r = await this.session.send('Runtime.evaluate', {
      expression: pierce ? `(${PIERCE_QUERY})(${JSON.stringify(sel)})` : `document.querySelector(${JSON.stringify(sel)})`,
    });
    if (r.exceptionDetails) throw evaluationError(r.exceptionDetails);
    if (!r.result.objectId || r.result.subtype === 'null') return null;
    const { node } = await this.session.send('DOM.describeNode', { objectId: r.result.objectId });
    return new ElementHandle(this, r.result.objectId, node.backendNodeId);
  }

  async waitForSelector(selector: string, opts: { timeout?: number } = {}): Promise<ElementHandle> {
    const timeout = opts.timeout ?? 30000;
    const deadline = Date.now() + timeout;
    for (;;) {
      const el = await this.$(selector);
      if (el) return el;
      if (Date.now() >= deadline) throw new Error(`Waiting for selector \`${selector}\` failed: Waiting failed: ${timeout}ms exceeded`);
      await sleep(50);
    }
  }

  async waitForFunction<Args extends unknown[]>(fn: string | ((...args: Args) => unknown), opts: { timeout?: number; polling?: number } = {}, ...args: Args): Promise<void> {
    const timeout = opts.timeout ?? 30000;
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await this.evaluate(fn as (...a: unknown[]) => unknown, ...args)) return;
      if (Date.now() >= deadline) throw new Error(`Waiting failed: ${timeout}ms exceeded`);
      await sleep(opts.polling ?? 100);
    }
  }

  /** 진행 중 요청이 없으면 마지막 활동 뒤 지난 ms, 있으면 -1 — 짧은 정착 판정용 */
  networkQuietFor(): number {
    return this.inflight.size === 0 ? Date.now() - this.lastActivity : -1;
  }

  /** 진행 중 요청이 `concurrency` 이하인 채로 `idleTime` 이 지나면 idle (puppeteer 와 같은 정의) */
  async waitForNetworkIdle(opts: { idleTime?: number; timeout?: number; concurrency?: number } = {}): Promise<void> {
    const idleTime = opts.idleTime ?? 500;
    const timeout = opts.timeout ?? 30000;
    const concurrency = opts.concurrency ?? 0;
    const deadline = Date.now() + timeout;
    for (;;) {
      if (this.inflight.size <= concurrency && Date.now() - this.lastActivity >= idleTime) return;
      if (Date.now() >= deadline) throw new Error(`Waiting for network idle failed: ${timeout}ms exceeded (${this.inflight.size} request(s) still in flight)`);
      await sleep(50);
    }
  }

  // --------------------------------------------------------- navigation

  /**
   * 네비게이션의 끝을 기다린다. 이벤트를 **먼저** 구독하고 나서 navigate 를 보내야 하므로
   * 취소할 수 있는 waiter 를 돌려준다.
   *
   * domcontentloaded → `Page.domContentEventFired` · load → `Page.loadEventFired` ·
   * 같은 문서 안의 이동(해시·pushState)은 둘 다 안 나므로 `Page.navigatedWithinDocument`
   * 로도 푼다. networkidle 은 load 뒤 진행 중 요청이 0/2 이하로 500ms.
   *
   * **bfcache 복원**(back/forward)은 문서를 다시 파싱하지 않아 load 이벤트가 없다 — 실측으로
   * `back` 이 30초 타임아웃했다. 그래서 메인 프레임의 `Page.frameNavigated` 뒤에
   * `document.readyState` 를 읽어, 이미 그 단계를 지났으면 끝낸다. 이벤트를 구독하기 전에
   * 이미 난 경우도 같은 길로 잡힌다.
   */
  private navigationWaiter(opts: NavigationOptions): Waiter<void> {
    const waitUntil = opts.waitUntil ?? 'load';
    const timeout = opts.timeout ?? 30000;
    let cancelled = false;
    const handlers: Array<() => void> = [];
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Navigation timeout of ${timeout} ms exceeded`)); }, timeout);
      const cleanup = () => { clearTimeout(timer); for (const h of handlers) h(); };
      const finish = () => { if (cancelled) return; cleanup(); resolve(); };
      const on = <E extends 'Page.domContentEventFired' | 'Page.loadEventFired' | 'Page.navigatedWithinDocument' | 'Page.frameNavigated'>(ev: E, h: (p: never) => void) => {
        this.session.on(ev, h as never);
        handlers.push(() => this.session.off(ev, h as never));
      };
      const wanted = waitUntil === 'domcontentloaded' ? ['interactive', 'complete'] : ['complete'];
      const afterLoad = waitUntil === 'load' || waitUntil.startsWith('networkidle')
        ? () => {
            if (!waitUntil.startsWith('networkidle')) return finish();
            const concurrency = waitUntil === 'networkidle0' ? 0 : 2;
            const remaining = Math.max(1, timeout - 0);
            this.waitForNetworkIdle({ concurrency, timeout: remaining }).then(finish, () => finish());
          }
        : finish;
      if (waitUntil === 'domcontentloaded') on('Page.domContentEventFired', finish);
      else on('Page.loadEventFired', afterLoad);
      on('Page.navigatedWithinDocument', finish);
      on('Page.frameNavigated', (p: Protocol.Page.FrameNavigatedEvent) => {
        if (p.frame.parentId || cancelled) return;
        this.session.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })
          .then(r => {
            if (cancelled) return;
            if (wanted.includes(String(r.result.value))) (waitUntil === 'domcontentloaded' ? finish : afterLoad)();
          })
          .catch(() => {});
      });
      handlers.push(() => { cancelled = true; });
    });
    return { promise, cancel: () => { cancelled = true; for (const h of handlers) h(); promise.catch(() => {}); } };
  }

  private responseFor(loaderId: string | undefined): HttpResponse | null {
    const r = loaderId ? this.docResponses.get(loaderId) : undefined;
    if (!r) return null;
    return { status: () => r.status, url: () => r.url, ok: () => r.status >= 200 && r.status < 300 };
  }

  async goto(url: string, opts: NavigationOptions = {}): Promise<HttpResponse | null> {
    const waiter = this.navigationWaiter(opts);
    let res: Protocol.Page.NavigateResponse;
    try {
      res = await this.session.send('Page.navigate', { url, frameId: this.mainFrameId || undefined });
    } catch (e) {
      waiter.cancel();
      throw e;
    }
    if (res.errorText) {
      waiter.cancel();
      throw new Error(`${res.errorText} at ${url}`);
    }
    await waiter.promise;
    return this.responseFor(res.loaderId);
  }

  async waitForNavigation(opts: NavigationOptions = {}): Promise<void> {
    await this.navigationWaiter(opts).promise;
  }

  async reload(opts: NavigationOptions & { ignoreCache?: boolean } = {}): Promise<void> {
    const waiter = this.navigationWaiter(opts);
    try {
      await this.session.send('Page.reload', { ignoreCache: opts.ignoreCache ?? false });
    } catch (e) {
      waiter.cancel();
      throw e;
    }
    await waiter.promise;
  }

  private async history(delta: number, opts: NavigationOptions): Promise<boolean> {
    const { currentIndex, entries } = await this.session.send('Page.getNavigationHistory');
    const entry = entries[currentIndex + delta];
    if (!entry) return false;
    const waiter = this.navigationWaiter(opts);
    try {
      await this.session.send('Page.navigateToHistoryEntry', { entryId: entry.id });
    } catch (e) {
      waiter.cancel();
      throw e;
    }
    await waiter.promise;
    return true;
  }

  /** 갈 곳이 없으면 false — puppeteer 는 null 을 돌려줬다 */
  goBack(opts: NavigationOptions = {}): Promise<boolean> {
    return this.history(-1, opts);
  }

  goForward(opts: NavigationOptions = {}): Promise<boolean> {
    return this.history(+1, opts);
  }

  // --------------------------------------------------------- screenshot

  async screenshot(opts: ScreenshotOptions = {}): Promise<Buffer> {
    let clip: Protocol.Page.Viewport | undefined;
    if (opts.clip) clip = { ...opts.clip, scale: 1 };
    if (opts.fullPage) {
      const m = await this.session.send('Page.getLayoutMetrics');
      const size = m.cssContentSize ?? m.contentSize;
      clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
    }
    const { data } = await this.session.send('Page.captureScreenshot', {
      format: opts.type ?? 'png',
      ...(opts.quality !== undefined && (opts.type ?? 'png') !== 'png' ? { quality: opts.quality } : {}),
      ...(clip ? { clip } : {}),
      captureBeyondViewport: !!opts.fullPage,
      optimizeForSpeed: opts.optimizeForSpeed ?? false,
    });
    return Buffer.from(data, 'base64');
  }

  // ---------------------------------------------------------- emulation

  /**
   * null 이면 오버라이드 해제.
   *
   * `mobile`/`hasTouch` 가 바뀌면 문서를 **다시 연다** — `'ontouchstart' in window` 같은
   * 것은 문서가 만들어질 때 정해져서, 오버라이드만으로는 다음 이동까지 데스크톱 문서인
   * 채다(실측: iPhone 14 에뮬레이션 뒤 ontouchstart false, reload 뒤 true). puppeteer 의
   * setViewport 가 같은 조건에서 reload 했고, 그 동작에 기대던 `emulate --device` 를 지킨다.
   */
  async setViewport(vp: Viewport | null): Promise<void> {
    const before = this.viewportState;
    if (!vp) {
      await this.session.send('Emulation.clearDeviceMetricsOverride');
      await this.session.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      this.viewportState = { mobile: false, hasTouch: false };
      if (before && (before.mobile || before.hasTouch)) await this.reloadIfDocument();
      return;
    }
    await this.session.send('Emulation.setDeviceMetricsOverride', {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: vp.deviceScaleFactor ?? 1,
      mobile: vp.isMobile ?? false,
      screenOrientation: vp.isLandscape ? { angle: 90, type: 'landscapePrimary' } : { angle: 0, type: 'portraitPrimary' },
    });
    await this.session.send('Emulation.setTouchEmulationEnabled', { enabled: vp.hasTouch ?? false });
    this.viewportState = { mobile: vp.isMobile ?? false, hasTouch: vp.hasTouch ?? false };
    if (before && (before.mobile !== this.viewportState.mobile || before.hasTouch !== this.viewportState.hasTouch)) {
      await this.reloadIfDocument();
    }
  }

  /** 세션이 아는 마지막 뷰포트 성격. 세션 첫 호출(before 없음)에는 reload 하지 않는다 — connect 마다 재적용되는 경로다 */
  private viewportState: { mobile: boolean; hasTouch: boolean } | null = null;

  private async reloadIfDocument(): Promise<void> {
    if (!/^https?:|^file:/.test(this.currentUrl)) return;
    await this.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  /** 빈 문자열이면 해제 */
  async setUserAgent(userAgent: string): Promise<void> {
    await this.session.send('Network.setUserAgentOverride', { userAgent });
  }

  async emulate(device: Device): Promise<void> {
    await this.setUserAgent(device.userAgent);
    await this.setViewport(device.viewport);
  }

  async emulateMediaFeatures(features: Array<{ name: string; value: string }>): Promise<void> {
    await this.session.send('Emulation.setEmulatedMedia', { features });
  }

  /** null 이면 해제 */
  async emulateNetworkConditions(c: { offline: boolean; download: number; upload: number; latency: number } | null): Promise<void> {
    await this.session.send('Network.emulateNetworkConditions', c
      ? { offline: c.offline, latency: c.latency, downloadThroughput: c.download, uploadThroughput: c.upload }
      : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  }

  /** null 이면 1배 */
  async emulateCPUThrottling(rate: number | null): Promise<void> {
    await this.session.send('Emulation.setCPUThrottlingRate', { rate: rate ?? 1 });
  }

  async setGeolocation(g: { latitude: number; longitude: number; accuracy?: number }): Promise<void> {
    await this.session.send('Emulation.setGeolocationOverride', { latitude: g.latitude, longitude: g.longitude, accuracy: g.accuracy ?? 0 });
  }

  async setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
    await this.session.send('Network.setExtraHTTPHeaders', { headers });
  }

  browserContext(): { overridePermissions(origin: string, permissions: string[]): Promise<void> } {
    return { overridePermissions: (origin, permissions) => this.browser.grantPermissions(origin, permissions) };
  }
}

/** `Tracing.*` — 결과는 스트림으로 받아 Buffer 로 */
export class Tracing {
  constructor(private readonly session: CdpSession) {}

  async start(opts: { categories?: string[]; screenshots?: boolean } = {}): Promise<void> {
    const categories = [...(opts.categories ?? DEFAULT_TRACE_CATEGORIES)];
    if (opts.screenshots) categories.push('disabled-by-default-devtools.screenshot');
    await this.session.send('Tracing.start', {
      transferMode: 'ReturnAsStream',
      traceConfig: { includedCategories: categories },
    });
  }

  async stop(): Promise<Buffer> {
    const complete = this.session.waitFor('Tracing.tracingComplete', { timeout: 60000 });
    await this.session.send('Tracing.end');
    const { stream } = await complete;
    if (!stream) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    for (;;) {
      const r = await this.session.send('IO.read', { handle: stream });
      chunks.push(r.base64Encoded ? Buffer.from(r.data, 'base64') : Buffer.from(r.data));
      if (r.eof) break;
    }
    await this.session.send('IO.close', { handle: stream }).catch(() => {});
    return Buffer.concat(chunks);
  }
}

const DEFAULT_TRACE_CATEGORIES = [
  '-*', 'devtools.timeline', 'v8.execute', 'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame', 'toplevel', 'blink.console', 'blink.user_timing',
  'latencyInfo', 'disabled-by-default-devtools.timeline.stack', 'disabled-by-default-v8.cpu_profiler',
];

function evaluationError(d: Protocol.Runtime.ExceptionDetails): Error {
  const message = d.exception?.description ?? d.exception?.value ?? d.text;
  return new Error(typeof message === 'string' ? message : String(message));
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
