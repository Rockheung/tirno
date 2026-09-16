/**
 * Chrome DevTools Protocol 클라이언트 — tirno 자신의 것 (#182).
 *
 * WebSocket 하나 위에 세션(타깃)을 다중화한다. 메시지는 `{id, method, params, sessionId}`
 * 로 나가고 `{id, result|error, sessionId}` 또는 `{method, params, sessionId}`(이벤트)로
 * 돌아온다. 그게 프로토콜의 전부다 — puppeteer 의 `Connection` 이 하는 일도 이것이다.
 *
 * 타입은 `devtools-protocol`(타입 전용 패키지)에서 온다. `send('Page.navigate', …)` 의
 * 파라미터와 응답이 컴파일 시점에 잡히므로 `as { … }` 캐스트가 필요 없다.
 *
 * 런타임 의존은 없다 — Node 22+ 와 bun 둘 다 전역 `WebSocket` 이 있다.
 */
import { EventEmitter } from 'node:events';
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';

export type Commands = ProtocolMapping.Commands;
export type Events = ProtocolMapping.Events;
export type Method = keyof Commands;
export type Params<M extends Method> = Commands[M]['paramsType'][0];
export type Result<M extends Method> = Commands[M]['returnType'];
export type EventName = keyof Events;
export type EventParams<E extends EventName> = Events[E][0];
/** 파라미터가 선택인 메서드는 인자 없이 부를 수 있다 */
export type SendArgs<M extends Method> = undefined extends Params<M> ? [params?: Params<M>] : [params: Params<M>];

/** 전송층 — 테스트는 가짜를 꽂고, 실전은 WebSocket 이다 */
export interface Transport {
  send(data: string): void;
  close(): void;
  onmessage: ((data: string) => void) | null;
  onclose: (() => void) | null;
}

/** Chrome 이 돌려준 프로토콜 오류. `method` 가 어느 호출이었는지 남긴다. */
export class CdpError extends Error {
  constructor(readonly method: string, readonly code: number | undefined, message: string, readonly detail?: string) {
    super(`Protocol error (${method}): ${message}${detail ? ` — ${detail}` : ''}`);
    this.name = 'CdpError';
  }
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

interface Incoming {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message: string; data?: string };
  sessionId?: string;
}

/**
 * 한 타깃과의 대화. `sessionId` 가 없으면 브라우저 자체(루트)다.
 * 이벤트는 이 세션으로 온 것만 받는다.
 */
export class CdpSession {
  private readonly emitter = new EventEmitter();
  private detached = false;

  constructor(readonly connection: CdpConnection, readonly id: string | undefined, readonly targetId?: string) {
    this.emitter.setMaxListeners(0);
  }

  send<M extends Method>(method: M, ...args: SendArgs<M>): Promise<Result<M>> {
    if (this.detached) return Promise.reject(new Error(`session ${this.id ?? 'root'} is detached — cannot send ${method}`));
    return this.connection.rawSend(method, args[0], this.id) as Promise<Result<M>>;
  }

  on<E extends EventName>(event: E, handler: (params: EventParams<E>) => void): this {
    this.emitter.on(event, handler);
    return this;
  }

  once<E extends EventName>(event: E, handler: (params: EventParams<E>) => void): this {
    this.emitter.once(event, handler);
    return this;
  }

  off<E extends EventName>(event: E, handler: (params: EventParams<E>) => void): this {
    this.emitter.off(event, handler);
    return this;
  }

  /** 이벤트 하나를 기다린다. `predicate` 가 있으면 맞는 것까지. 시간이 넘으면 던진다. */
  waitFor<E extends EventName>(event: E, opts: { timeout?: number; predicate?: (p: EventParams<E>) => boolean } = {}): Promise<EventParams<E>> {
    return new Promise((resolve, reject) => {
      const timer = opts.timeout ? setTimeout(() => { this.off(event, handler); reject(new Error(`timed out after ${opts.timeout}ms waiting for ${event}`)); }, opts.timeout) : null;
      const handler = (p: EventParams<E>) => {
        if (opts.predicate && !opts.predicate(p)) return;
        if (timer) clearTimeout(timer);
        this.off(event, handler);
        resolve(p);
      };
      this.on(event, handler);
    });
  }

  /** @internal 연결이 이 세션의 이벤트를 넘긴다 */
  dispatch(method: string, params: unknown): void {
    this.emitter.emit(method, params);
  }

  get isDetached(): boolean {
    return this.detached;
  }

  /** 타깃에서 떨어진다. 루트 세션은 떨어질 것이 없다 — 연결을 닫아라. */
  async detach(): Promise<void> {
    if (this.detached || !this.id) return;
    this.detached = true;
    try {
      await this.connection.rawSend('Target.detachFromTarget', { sessionId: this.id }, undefined);
    } catch {
      // 타깃이 먼저 죽었으면 이미 떨어진 것이다
    }
    this.connection.forget(this.id);
  }

  /** @internal Chrome 쪽에서 떨어졌다(타깃 소멸 등) */
  markDetached(): void {
    this.detached = true;
    this.emitter.removeAllListeners();
  }
}

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly sessions = new Map<string, CdpSession>();
  private closed = false;
  readonly root: CdpSession;
  /** 연결이 닫힐 때 — 남은 호출은 전부 reject 된 뒤다 */
  onclose: (() => void) | null = null;

  constructor(private readonly transport: Transport, readonly url?: string) {
    this.root = new CdpSession(this, undefined);
    transport.onmessage = (data) => this.receive(data);
    transport.onclose = () => this.handleClose();
  }

  /**
   * WebSocket 으로 연다. 전역 `WebSocket` 을 쓴다(Node 22+, bun). 연결 실패는 그 자리에서
   * 던진다 — "붙는 중" 상태로 돌아가지 않는다.
   */
  static open(wsUrl: string, opts: { timeout?: number } = {}): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => { ws.close(); reject(new Error(`timed out after ${opts.timeout ?? 10000}ms connecting to ${wsUrl}`)); }, opts.timeout ?? 10000);
      const transport: Transport = {
        send: (d) => ws.send(d),
        close: () => ws.close(),
        onmessage: null,
        onclose: null,
      };
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        ws.addEventListener('message', (ev) => transport.onmessage?.(String(ev.data)));
        ws.addEventListener('close', () => transport.onclose?.());
        resolve(new CdpConnection(transport, wsUrl));
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`could not connect to ${wsUrl} — nothing is listening there, or it is not a DevTools endpoint`));
      });
    });
  }

  /** 루트 세션의 send — `connection.send('Target.getTargets')` 처럼 쓴다 */
  send<M extends Method>(method: M, ...args: SendArgs<M>): Promise<Result<M>> {
    return this.root.send(method, ...args);
  }

  on<E extends EventName>(event: E, handler: (params: EventParams<E>) => void): this {
    this.root.on(event, handler);
    return this;
  }

  /** @internal */
  rawSend(method: string, params: unknown, sessionId: string | undefined): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`connection closed — cannot send ${method}`));
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params: params ?? {} };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      try {
        this.transport.send(JSON.stringify(message));
      } catch (e) {
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  /**
   * 타깃에 붙어 세션을 만든다. `flatten: true` 라 이후 메시지가 `sessionId` 필드로
   * 다중화된다 — 세션마다 WebSocket 을 따로 열지 않는다.
   */
  async attach(targetId: string): Promise<CdpSession> {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return this.sessionFor(sessionId, targetId);
  }

  /** @internal 이미 붙은 세션(Target.attachedToTarget 이벤트 등)을 객체로 */
  sessionFor(sessionId: string, targetId?: string): CdpSession {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = new CdpSession(this, sessionId, targetId);
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /** @internal */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private receive(data: string): void {
    let msg: Incoming;
    try {
      msg = JSON.parse(data) as Incoming;
    } catch {
      return; // 프로토콜이 아닌 것은 무시한다 — 여기서 던지면 연결 전체가 죽는다
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CdpError(p.method, msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    // 세션이 사라졌다는 통지는 루트로 오고, 해당 세션을 정리한다
    if (msg.method === 'Target.detachedFromTarget') {
      const { sessionId } = msg.params as { sessionId: string };
      this.sessions.get(sessionId)?.markDetached();
      this.sessions.delete(sessionId);
    }
    const target = msg.sessionId ? this.sessions.get(msg.sessionId) : this.root;
    target?.dispatch(msg.method, msg.params);
    // 자식 세션의 이벤트를 루트에서도 볼 수 있게 — `Target.*` 류 관측용
    if (msg.sessionId) this.root.dispatch(`session:${msg.method}`, { sessionId: msg.sessionId, params: msg.params });
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new Error(`connection closed while waiting for ${p.method}`));
    }
    for (const s of this.sessions.values()) s.markDetached();
    this.sessions.clear();
    this.onclose?.();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 연결만 닫는다. Chrome 은 그대로 돈다 — puppeteer 의 `disconnect()` 에 해당한다. */
  close(): void {
    if (this.closed) return;
    this.transport.close();
    this.handleClose();
  }
}
