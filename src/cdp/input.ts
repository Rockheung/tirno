/**
 * 키보드와 마우스 — `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent` 위 (#182).
 *
 * 동작은 puppeteer 의 Keyboard/Mouse 를 따른다(출처: puppeteer/src/cdp/Input.ts). 새로
 * 발명하지 않는 이유: 어느 키가 `keyDown` 이고 어느 키가 `rawKeyDown` 인지, 수식키가
 * 눌린 채로는 `text` 를 비워야 한다는 것 같은 규칙은 브라우저의 것이고, puppeteer 는 그것을
 * 몇 년에 걸쳐 맞춰 왔다.
 */
import type { CdpSession } from './client.js';
import { KEY_DEFINITIONS, type KeyDefinition, type KeyInput } from './us-keyboard-layout.js';
import type { Protocol } from 'devtools-protocol';

export type { KeyInput };

const MODIFIER_BIT: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

interface KeyDescription {
  key: string;
  keyCode: number;
  code: string;
  text: string;
  location: number;
}

export class Keyboard {
  /** Alt=1 · Control=2 · Meta=4 · Shift=8 — 마우스 이벤트도 이 값을 싣는다 */
  modifiers = 0;
  private readonly pressed = new Set<string>();

  constructor(private readonly session: CdpSession) {}

  private describe(key: string): KeyDescription {
    const def = (KEY_DEFINITIONS as Record<string, KeyDefinition>)[key];
    if (!def) throw new Error(`Unknown key: "${key}"`);
    const shift = (this.modifiers & 8) !== 0;
    const d: KeyDescription = {
      key: shift && def.shiftKey ? def.shiftKey : (def.key ?? ''),
      keyCode: shift && def.shiftKeyCode ? def.shiftKeyCode : (def.keyCode ?? 0),
      code: def.code ?? '',
      text: '',
      location: def.location ?? 0,
    };
    if (d.key.length === 1) d.text = d.key;
    if (def.text) d.text = def.text;
    if (shift && def.shiftText) d.text = def.shiftText;
    // Shift 말고 다른 수식키가 눌려 있으면 글자는 안 들어간다 — Ctrl+a 가 'a' 를 치면 안 된다
    if (this.modifiers & ~8) d.text = '';
    return d;
  }

  async down(key: KeyInput | string, opts: { text?: string; commands?: string[] } = {}): Promise<void> {
    const d = this.describe(key);
    const autoRepeat = this.pressed.has(d.code);
    this.pressed.add(d.code);
    this.modifiers |= MODIFIER_BIT[d.key] ?? 0;
    const text = opts.text ?? d.text;
    await this.session.send('Input.dispatchKeyEvent', {
      type: text ? 'keyDown' : 'rawKeyDown',
      modifiers: this.modifiers,
      windowsVirtualKeyCode: d.keyCode,
      code: d.code,
      key: d.key,
      text,
      unmodifiedText: text,
      autoRepeat,
      location: d.location,
      isKeypad: d.location === 3,
      ...(opts.commands ? { commands: opts.commands } : {}),
    });
  }

  async up(key: KeyInput | string): Promise<void> {
    const d = this.describe(key);
    this.modifiers &= ~(MODIFIER_BIT[d.key] ?? 0);
    this.pressed.delete(d.code);
    await this.session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: this.modifiers,
      key: d.key,
      windowsVirtualKeyCode: d.keyCode,
      code: d.code,
      location: d.location,
    });
  }

  /** 키 이벤트 없이 글자를 넣는다 — 표에 없는 글자(한글·이모지)는 이 길로 간다 */
  async sendCharacter(text: string): Promise<void> {
    await this.session.send('Input.insertText', { text });
  }

  async press(key: KeyInput | string, opts: { delay?: number; text?: string; commands?: string[] } = {}): Promise<void> {
    await this.down(key, opts);
    if (opts.delay) await sleep(opts.delay);
    await this.up(key);
  }

  async type(text: string, opts: { delay?: number } = {}): Promise<void> {
    for (const char of text) {
      if (char in KEY_DEFINITIONS) {
        await this.press(char, { delay: opts.delay });
      } else {
        if (opts.delay) await sleep(opts.delay);
        await this.sendCharacter(char);
      }
    }
  }
}

export type MouseButton = 'left' | 'right' | 'middle' | 'back' | 'forward';

export class Mouse {
  private x = 0;
  private y = 0;
  private button: MouseButton | 'none' = 'none';

  constructor(private readonly session: CdpSession, private readonly keyboard: Keyboard) {}

  position(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  async move(x: number, y: number, opts: { steps?: number } = {}): Promise<void> {
    const steps = Math.max(1, opts.steps ?? 1);
    const fromX = this.x, fromY = this.y;
    this.x = x;
    this.y = y;
    for (let i = 1; i <= steps; i++) {
      await this.session.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        button: this.button,
        x: fromX + (x - fromX) * (i / steps),
        y: fromY + (y - fromY) * (i / steps),
        modifiers: this.keyboard.modifiers,
      });
    }
  }

  async down(opts: { button?: MouseButton; clickCount?: number } = {}): Promise<void> {
    this.button = opts.button ?? 'left';
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: this.button,
      x: this.x,
      y: this.y,
      modifiers: this.keyboard.modifiers,
      clickCount: opts.clickCount ?? 1,
    });
  }

  async up(opts: { button?: MouseButton; clickCount?: number } = {}): Promise<void> {
    const button = opts.button ?? 'left';
    this.button = 'none';
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button,
      x: this.x,
      y: this.y,
      modifiers: this.keyboard.modifiers,
      clickCount: opts.clickCount ?? 1,
    });
  }

  /** move → down → up. `count` 는 clickCount 로 나간다(2 면 더블클릭으로 해석된다). */
  async click(x: number, y: number, opts: { button?: MouseButton; count?: number; delay?: number } = {}): Promise<void> {
    await this.move(x, y);
    await this.down({ button: opts.button, clickCount: opts.count ?? 1 });
    if (opts.delay) await sleep(opts.delay);
    await this.up({ button: opts.button, clickCount: opts.count ?? 1 });
  }

  async wheel(opts: { deltaX?: number; deltaY?: number } = {}): Promise<void> {
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: this.x,
      y: this.y,
      deltaX: opts.deltaX ?? 0,
      deltaY: opts.deltaY ?? 0,
      modifiers: this.keyboard.modifiers,
      pointerType: 'mouse',
    } as Protocol.Input.DispatchMouseEventRequest);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
