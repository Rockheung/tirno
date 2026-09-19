/**
 * Browser — 브라우저 하나와의 연결, 타깃 목록, 페이지 (#182).
 *
 * `pages()` 는 `Target.getTargets` 로 즉시 답한다. 렌더러를 기다리지 않는다 — puppeteer 의
 * Page 초기화는 렌더러에 물어 멈춘 페이지에서 17초를 먹었고(perf.ts 의 실측), 그래서
 * perf 는 `browser.targets()` 로 우회해야 했다. 여기서는 둘이 같은 경로다.
 */
import type { Protocol } from 'devtools-protocol';
import { CdpConnection, type CdpSession } from './client.js';
import { Page } from './page.js';

/** 웹 권한 이름 → 프로토콜 이름 (puppeteer 의 WEB_PERMISSION_TO_PROTOCOL_PERMISSION) */
const PERMISSION_TO_PROTOCOL: Record<string, Protocol.Browser.PermissionType> = {
  'geolocation': 'geolocation',
  'midi': 'midi',
  'notifications': 'notifications',
  'camera': 'videoCapture',
  'microphone': 'audioCapture',
  'background-sync': 'backgroundSync',
  'ambient-light-sensor': 'sensors',
  'accelerometer': 'sensors',
  'gyroscope': 'sensors',
  'magnetometer': 'sensors',
  'clipboard-read': 'clipboardReadWrite',
  'clipboard-write': 'clipboardReadWrite',
  'clipboard-sanitized-write': 'clipboardSanitizedWrite',
  'payment-handler': 'paymentHandler',
  'persistent-storage': 'durableStorage',
  'idle-detection': 'idleDetection',
  'midi-sysex': 'midiSysex',
  'keyboard-lock': 'keyboardLock',
  'pointer-lock': 'pointerLock',
};

/** 타깃 하나의 메타 — 렌더러에 묻지 않고 브라우저 프로세스가 아는 것 */
export class Target {
  constructor(private readonly browser: Browser, readonly info: Protocol.Target.TargetInfo) {}
  type(): string {
    return this.info.type;
  }
  url(): string {
    return this.info.url;
  }
  get targetId(): string {
    return this.info.targetId;
  }
  createCDPSession(): Promise<CdpSession> {
    return this.browser.connection.attach(this.info.targetId);
  }
}

/** 쿠키 — `Storage.getCookies` 가 주는 모양 */
export type Cookie = Protocol.Network.Cookie;

export class Browser {
  private readonly pageCache = new Map<string, Page>();
  private discovering = false;
  /** `select` 가 고른 탭 — connect 가 세션 메타에서 실어 준다. page-resolver 가 먼저 본다 */
  preferredTargetId?: string;

  private constructor(readonly connection: CdpConnection) {}

  static async connect(wsEndpoint: string): Promise<Browser> {
    return new Browser(await CdpConnection.open(wsEndpoint));
  }

  wsEndpoint(): string {
    return this.connection.url ?? '';
  }

  /** 연결만 끊는다. Chrome 은 그대로 돈다. */
  disconnect(): void {
    this.connection.close();
  }

  async targets(): Promise<Target[]> {
    const { targetInfos } = await this.connection.send('Target.getTargets');
    return targetInfos.map(i => new Target(this, i));
  }

  /** 브라우저 타깃 — 브라우저 도메인(`Storage`·`Browser`·`Target`)은 루트 세션이 이미 말한다 */
  target(): { createCDPSession(): Promise<CdpSession> } {
    return { createCDPSession: async () => this.connection.root };
  }

  /**
   * 열린 탭들 — `type === 'page'` 인 타깃. 순서는 Chrome 이 주는 대로(생성 순).
   * 한 번 붙은 페이지는 캐시한다 — 세션과 그 위의 오버라이드가 연결 동안 살아야 한다.
   */
  async pages(): Promise<Page[]> {
    const targets = await this.targets();
    const pages: Page[] = [];
    const live = new Set<string>();
    for (const t of targets) {
      if (t.type() !== 'page') continue;
      live.add(t.targetId);
      let page = this.pageCache.get(t.targetId);
      if (!page) {
        try {
          page = await Page.attach(this, t.targetId, t.url());
        } catch {
          continue; // 붙는 사이 닫혔다
        }
        this.pageCache.set(t.targetId, page);
      }
      pages.push(page);
    }
    for (const id of this.pageCache.keys()) if (!live.has(id)) this.pageCache.delete(id);
    return pages;
  }

  async newPage(url = 'about:blank'): Promise<Page> {
    const { targetId } = await this.connection.send('Target.createTarget', { url });
    const page = await Page.attach(this, targetId, url);
    this.pageCache.set(targetId, page);
    return page;
  }

  /** @internal */
  forgetPage(targetId: string): void {
    this.pageCache.delete(targetId);
  }

  /** 새 타깃이 생기면 — 연결이 살아 있는 동안만 */
  on(event: 'targetcreated', handler: (t: Target) => void): this {
    if (!this.discovering) {
      this.discovering = true;
      this.connection.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
    }
    this.connection.on('Target.targetCreated', ({ targetInfo }) => handler(new Target(this, targetInfo)));
    return this;
  }

  async cookies(): Promise<Cookie[]> {
    const { cookies } = await this.connection.send('Storage.getCookies');
    return cookies;
  }

  /** `cookies()` 로 받은 것을 그대로 넣는다. 세션 쿠키(expires -1)는 만료 없이 들어간다. */
  async setCookie(...cookies: Cookie[]): Promise<void> {
    const params: Protocol.Network.CookieParam[] = cookies.map(c => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
      ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
      priority: c.priority, sameParty: c.sameParty, sourceScheme: c.sourceScheme, sourcePort: c.sourcePort,
      ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}),
    }));
    await this.connection.send('Storage.setCookies', { cookies: params });
  }

  async grantPermissions(origin: string, permissions: string[]): Promise<void> {
    const mapped = permissions.map(p => {
      const proto = PERMISSION_TO_PROTOCOL[p];
      if (!proto) throw new Error(`Unknown permission: ${p}`);
      return proto;
    });
    await this.connection.send('Browser.grantPermissions', { origin, permissions: mapped });
  }

  async clearPermissionOverrides(): Promise<void> {
    await this.connection.send('Browser.resetPermissions');
  }

  defaultBrowserContext(): {
    overridePermissions(origin: string, permissions: string[]): Promise<void>;
    clearPermissionOverrides(): Promise<void>;
  } {
    return {
      overridePermissions: (o, p) => this.grantPermissions(o, p),
      clearPermissionOverrides: () => this.clearPermissionOverrides(),
    };
  }
}
