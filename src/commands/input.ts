import { Command } from 'commander';
import { intArg, stripTrailingNewline } from '../util/parsers.js';
import { connect } from '../core/chrome-connector.js';
import { getActivePage, getInteractivePage } from '../cdp/page-resolver.js';
import { success, fail } from '../output/formatter.js';
import { TirnoError } from '../util/errors.js';
import { actWithDelta, printDelta, DELTA_FLAG } from './delta-output.js';
import { clickByRef, fillByRef, hoverByRef, requireElement } from '../cdp/dom-actions.js';
import { resolveTarget, takesName, findByRoleName, axRole } from '../cdp/target.js';
import { asCoords } from '../cdp/dom-actions.js';
import { editingCommandFor, keyCodeName, modifierBits, parseKeyCombo, virtualKeyCode } from '../cdp/keys.js';
import type { Page } from '../cdp/page.js';

/**
 * 파이프로 들어온 값 전부.
 *
 * TTY 면 바로 거절한다 — 붙여넣기를 기다리는 것처럼 보이지만 실제로는 아무도
 * 끝내 주지 않아 그대로 매달린다.
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error('--value-stdin needs piped input, e.g. `pbpaste | tirno fill \'input[type=password]\' --value-stdin`');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

async function elemCenter(page: Page, selector: string): Promise<[number, number]> {
  const box = await (await requireElement(page, selector)).boundingBox();
  if (!box) throw new Error(`Element has no layout box (display:none?): ${selector}`);
  return [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)];
}

export function registerInputCommands(program: Command): void {
  program
    .command('click')
    .description('Click by role + visible name (`click button "Submit"`), CSS selector, @ref, or "x,y" coordinates. A selector that misses in the light DOM is retried through open shadow roots. Sends a real mouse click at the element\'s centre, so focus moves the way a person\'s click moves it (a `fill` before this commits its `change`; a `type` after this lands in it). Fails with exit 1 if another element covers that point — a modal, a cookie banner, a sticky header — naming what is on top. A role+name that matches several elements is refused with the candidates listed')
    .argument('<target>', 'CSS selector, @N ref, "<x>,<y>" coordinates, or a role word (button · link · textbox · checkbox · combobox · heading · text …) followed by the visible name')
    .argument('[name]', 'Accessible name when <target> is a role word — partial and case-insensitive by default (an exact match wins when several overlap); --exact for exact')
    .option('-s, --session <name>', 'Session name')
    .option('--exact', 'Match the accessible name exactly (case-sensitive)')
    .option('--dbl', 'Double click')
    .option('--stale-ok', 'Use the ref even if the page changed under the snapshot — see `snapshot` generations')
    .option('--synthetic', 'Dispatch element.click() instead of a mouse click. Ignores whatever covers the element and the viewport — for elements larger than the viewport, or hidden ones that still have handlers. No pointer/mouse events are fired')
    .option(...DELTA_FLAG)
    .action(async (target: string, name: string | undefined, opts) => {
      try {
        const { browser, meta } = await connect(opts.session);
        const page = await getInteractivePage(browser);

        // 대상은 행동 밖에서 푼다 — 낡은 ref 거절·모호한 이름 거절은 행동이 아니다
        const t = await resolveTarget(page, target, name, { session: meta.name, staleOk: !!opts.staleOk, exact: !!opts.exact });

        // "x,y" coordinate form — dispatch raw CDP mouse events (trusted click).
        if (t.kind === 'coords') {
          const { x, y } = t;
          const { delta } = await actWithDelta(page, opts, async () => {
            const cdp = await page.createCDPSession();
            try {
              const clickCount = opts.dbl ? 2 : 1;
              await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount });
              await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount });
              if (opts.dbl) {
                await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount });
                await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount });
              }
            } finally {
              await cdp.detach();
            }
          });
          browser.disconnect();
          success(`Clicked (${x},${y})${opts.dbl ? ' (dbl)' : ''}`);
          printDelta(delta);
          return;
        }

        const clickOpts = { label: t.label, dbl: !!opts.dbl, synthetic: !!opts.synthetic };
        const { delta } = await actWithDelta(page, opts, () => clickByRef(page, t.backendNodeId, clickOpts));

        browser.disconnect();
        success(`Clicked ${t.label}${opts.synthetic ? ' (synthetic)' : ''}`);
        printDelta(delta);
      } catch (e) {
        fail(e);
      }
    });

  program
    .command('fill')
    .description('Clear and type into a field by role + name (`fill textbox "Email" me@x.com`), CSS selector, or @ref. A selector that misses in the light DOM is retried through open shadow roots')
    .argument('[target]', 'Role word, CSS selector or @N ref (omit when --batch)')
    .argument('[nameOrValue]', 'The accessible name when <target> is a role word, otherwise the value')
    .argument('[value]', 'Value to fill when a name was given (omit when --batch or --value-stdin)')
    .option('-s, --session <name>', 'Session name')
    .option('--exact', 'Match the accessible name exactly (case-sensitive)')
    .option('--batch <json>', 'Fill multiple fields in one call. JSON array: [{"target":"#a","value":"x"},{"target":"textbox","name":"Email","value":"y"},...]')
    .option('--value-stdin', 'Read the value from stdin instead of the argument, e.g. `pbpaste | tirno fill \'input[type=password]\' --value-stdin`. The value is never printed.')
    .option('--stale-ok', 'Use the ref even if the page changed under the snapshot — see `snapshot` generations')
    .option(...DELTA_FLAG)
    .option('--no-verify', 'Skip reading the value back after typing. By default a field that ends up holding something else (readonly, maxlength, a keydown handler, focus moved) fails with exit 1 instead of "Filled" — turn this off only for inputs whose formatter rewrites what you type')
    .action(async (target: string | undefined, nameOrValue: string | undefined, valueArg: string | undefined, opts) => {
      try {
        // role 단어 뒤엔 이름이 온다 — `fill textbox "Email" me@x` 는 셋, `fill '#q' me@x` 는 둘
        const named = target !== undefined && takesName(target);
        const name = named ? nameOrValue : undefined;
        let value: string | undefined = named ? valueArg : nameOrValue;
        // 값이 인자로 오면 `ps` 와 셸 히스토리에 남는다. 비밀번호를 넣는 흔한 자리라
        // 파이프 경로를 둔다 — 넣고 나서 되돌릴 수 없는 종류의 노출이다.
        let fromStdin = false;
        if (opts.valueStdin) {
          if (opts.batch) throw new Error('--value-stdin and --batch are mutually exclusive');
          if (value !== undefined) throw new Error('--value-stdin takes the value from stdin — do not also pass <value>');
          value = stripTrailingNewline(await readStdin());
          fromStdin = true;
        }

        const { browser, meta } = await connect(opts.session);
        const page = await getInteractivePage(browser);

        if (opts.batch) {
          let entries: Array<{ target: string; name?: string; value: string }>;
          try {
            const parsed = JSON.parse(opts.batch);
            if (!Array.isArray(parsed)) throw new Error('expected array');
            entries = parsed;
          } catch (e) {
            throw new Error(`--batch invalid JSON: ${(e as Error).message}`, { cause: e });
          }
          for (const entry of entries) {
            if (!entry.target || typeof entry.value !== 'string') {
              throw new Error(`--batch entries need {target, value}`);
            }
          }
          const { delta } = await actWithDelta(page, opts, async () => {
            for (const entry of entries) {
              const t = await resolveTarget(page, entry.target, entry.name, { session: meta.name, staleOk: !!opts.staleOk, exact: !!opts.exact });
              if (t.kind === 'coords') throw new Error('fill takes an element, not coordinates');
              await fillByRef(page, t.backendNodeId, entry.value, { label: t.label, verify: opts.verify !== false });
            }
          });
          browser.disconnect();
          success(`Filled ${entries.length} field${entries.length === 1 ? '' : 's'}`);
          printDelta(delta);
          return;
        }

        if (!target || value === undefined) {
          throw new Error(named ? 'Provide <role> <name> <value>, or --value-stdin' : 'Provide <target> <value> or --batch <json>');
        }

        const t = await resolveTarget(page, target, name, { session: meta.name, staleOk: !!opts.staleOk, exact: !!opts.exact });
        if (t.kind === 'coords') throw new Error('fill takes an element, not coordinates');
        const fillOpts = { label: t.label, verify: opts.verify !== false, hideValue: fromStdin };
        const v = value;
        const { delta } = await actWithDelta(page, opts, () => fillByRef(page, t.backendNodeId, v, fillOpts));

        browser.disconnect();
        // stdin 으로 받은 값은 찍지 않는다 — argv 를 피해 넣은 것을 터미널에
        // 도로 남기면 피한 의미가 없다.
        success(fromStdin
          ? `Filled ${t.label} (${value.length} chars from stdin)`
          : `Filled ${t.label} with "${value}"`);
        printDelta(delta);
      } catch (e) {
        fail(e);
      }
    });

  program
    .command('type')
    .description('Type text (keyboard input)')
    .argument('<text>', 'Text to type')
    .option('-s, --session <name>', 'Session name')
    .option('--delay <ms>', 'Delay between keystrokes', intArg, 0)
    .option(...DELTA_FLAG)
    .action(async (text: string, opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        const { delta } = await actWithDelta(page, opts, () => page.keyboard.type(text, { delay: opts.delay }));

        browser.disconnect();
        success(`Typed "${text.slice(0, 40)}${text.length > 40 ? '...' : ''}"`);
        printDelta(delta);
      } catch (e) {
        fail(e);
      }
    });

  program
    .command('press')
    .description('Press a key, or a modifier combo like "Meta+v" / "Shift+Tab"')
    .argument('<key>', 'Key name (Enter, Tab, Escape, ArrowDown, ...) or <modifier>+<key>')
    .option('-s, --session <name>', 'Session name')
    .option(...DELTA_FLAG)
    .action(async (key: string, opts) => {
      try {
        const combo = parseKeyCombo(key);
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        const { delta } = await actWithDelta(page, opts, async () => {
        if (combo.modifiers.length === 0) {
          await page.keyboard.press(key as string);
        } else {
          const command = editingCommandFor(combo);
          if (command) {
            // 편집 조작은 키 이벤트만으로는 일어나지 않는다. 브라우저가 그 동작을
            // 실행하려면 `commands` 를 함께 받아야 한다 — 실측으로, commands 없이
            // Meta+V 를 보내면 포커스된 필드의 값이 그대로였다.
            const cdp = await page.createCDPSession();
            try {
              const base = {
                key: combo.key,
                code: keyCodeName(combo.key),
                modifiers: modifierBits(combo.modifiers),
                windowsVirtualKeyCode: virtualKeyCode(combo.key),
                nativeVirtualKeyCode: virtualKeyCode(combo.key),
              };
              await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyDown', commands: [command] });
              await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
            } finally {
              await cdp.detach();
            }
          } else {
            // 편집 명령이 아닌 조합은 Keyboard 가 us-keyboard-layout 표로 눌러 준다 —
            // 여기서 전체 표를 다시 들 이유가 없다.
            const mods = combo.modifiers as string[];
            for (const m of mods) await page.keyboard.down(m);
            try {
              await page.keyboard.press(combo.key as string);
            } finally {
              for (const m of [...mods].reverse()) await page.keyboard.up(m);
            }
          }
        }
        });

        browser.disconnect();
        success(`Pressed ${key}`);
        printDelta(delta);
      } catch (e) {
        fail(e);
      }
    });

  program
    .command('hover')
    .description('Hover by role + name (`hover link "Docs"`), CSS selector, @ref, or "x,y" coordinates. A selector that misses in the light DOM is retried through open shadow roots')
    .argument('<target>', 'CSS selector, @N ref, "<x>,<y>" coordinates, or a role word (button · link · textbox · checkbox · combobox · heading · text …) followed by the visible name')
    .argument('[name]', 'Accessible name when <target> is a role word — partial and case-insensitive by default (an exact match wins when several overlap); --exact for exact')
    .option('-s, --session <name>', 'Session name')
    .option('--exact', 'Match the accessible name exactly (case-sensitive)')
    .option('--stale-ok', 'Use the ref even if the page changed under the snapshot — see `snapshot` generations')
    .action(async (target: string, name: string | undefined, opts) => {
      try {
        const { browser, meta } = await connect(opts.session);
        const page = await getInteractivePage(browser);

        // 좌표를 받는 이유는 click 과의 대칭만이 아니다. 닫힌 shadow root 안이나
        // 셀렉터가 없는 캔버스 위 요소에는 좌표가 유일한 길이고, 그 길이 click 에만
        // 있으면 그런 요소는 hover 시킬 방법이 아예 없다.
        const t = await resolveTarget(page, target, name, { session: meta.name, staleOk: !!opts.staleOk, exact: !!opts.exact });
        if (t.kind === 'coords') await page.mouse.move(t.x, t.y);
        else await hoverByRef(page, t.backendNodeId);

        browser.disconnect();
        success(`Hovered ${t.label}`);
      } catch (e) {
        fail(e);
      }
    });

  program
    .command('drag')
    .description('Drag from <from> to <to>. Coords as "x,y" or selectors (auto-detect).')
    .argument('<from>', 'Source: "x,y" coord or CSS selector')
    .argument('<to>', 'Destination: "x,y" coord or CSS selector')
    .option('-s, --session <name>', 'Session name')
    .option('--steps <n>', 'Intermediate mousemove steps (default 20)', intArg, 20)
    .option('--hold <ms>', 'Hold time at source after mousedown (default 100)', intArg, 100)
    .option('--native', 'Force native HTML5 drag intercept even with coord args')
    .action(async (from: string, to: string, opts) => {
      try {
        const isCoord = (t: string) => asCoords(t) !== null;

        const { browser } = await connect(opts.session);
        const page = await getInteractivePage(browser);

        // native HTML5 drag intercept path (selector OR coord — drag with
        // CDP intercept gives the page the trusted dataTransfer it needs)
        if (!isCoord(from) && !isCoord(to) || opts.native) {
          const [fx, fy] = asCoords(from) ?? await elemCenter(page, from);
          const [tx, ty] = asCoords(to) ?? await elemCenter(page, to);
          const cdp = await page.createCDPSession();
          let dragData: unknown = null;
          cdp.on('Input.dragIntercepted', (e: unknown) => { dragData = (e as { data: unknown }).data; });
          await cdp.send('Input.setInterceptDrags', { enabled: true });
          await page.mouse.move(fx, fy);
          await page.mouse.down();
          // small move to trigger dragstart → dragIntercepted
          await page.mouse.move(fx + 5, fy + 5);
          await page.mouse.move(tx, ty, { steps: opts.steps });
          // wait for intercept to capture data
          await new Promise(r => setTimeout(r, 150));
          if (dragData) {
             
            const data = dragData as any;
             
            const sendAny = cdp.send.bind(cdp) as any;
            await sendAny('Input.dispatchDragEvent', { type: 'dragEnter', x: tx, y: ty, data });
            await sendAny('Input.dispatchDragEvent', { type: 'dragOver', x: tx, y: ty, data });
            await sendAny('Input.dispatchDragEvent', { type: 'drop', x: tx, y: ty, data });
          }
          await page.mouse.up();
          await cdp.send('Input.setInterceptDrags', { enabled: false });
          await cdp.detach();
          browser.disconnect();
          success(`Dragged "${from}" (${fx},${fy}) → "${to}" (${tx},${ty}) ${dragData ? '[native drag]' : '[no drag data — mouse only]'}`);
          return;
        }

        // coord-based fallback (mouse events only — no native drag)
        const [fx, fy] = asCoords(from) ?? await elemCenter(page, from);
        const [tx, ty] = asCoords(to) ?? await elemCenter(page, to);
        await page.mouse.move(fx, fy);
        await page.mouse.down();
        await new Promise(r => setTimeout(r, opts.hold));
        await page.mouse.move(tx, ty, { steps: opts.steps });
        await page.mouse.up();

        browser.disconnect();
        success(`Dragged (${fx},${fy}) → (${tx},${ty}) (mouse only)`);
      } catch (e) {
        fail(e);
      }
    });

  program
    .command('scroll')
    .description('Scroll the page (up|down|<pixels>)')
    .argument('<direction>', 'up | down | a positive/negative pixel amount')
    .option('-s, --session <name>', 'Session name')
    .option('--step <px>', 'Pixels per up/down (default 600)', intArg, 600)
    .action(async (direction: string, opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        let dy: number;
        if (direction === 'up') dy = -opts.step;
        else if (direction === 'down') dy = opts.step;
        else {
          const n = Number(direction);
          if (Number.isNaN(n)) throw new Error(`Invalid direction: ${direction}. Use up | down | <pixels>`);
          dy = n;
        }

        await page.evaluate((y: number) => window.scrollBy({ top: y, behavior: 'instant' as ScrollBehavior }), dy);

        browser.disconnect();
        success(`Scrolled ${dy > 0 ? '+' : ''}${dy}px`);
      } catch (e) {
        fail(e);
      }
    });

  program
    .command('wait')
    .description('Sleep for milliseconds')
    .argument('<ms>', 'Milliseconds to wait', intArg)
    .action(async (ms: number) => {
      try {
        if (!Number.isFinite(ms) || ms < 0) throw new Error('Milliseconds must be a non-negative integer');
        await new Promise(r => setTimeout(r, ms));
        success(`Waited ${ms}ms`);
      } catch (e) {
        fail(e);
      }
    });

  program
    .command('wait-for')
    .description('Wait for an element (role + name, or CSS selector), text, or network idle. A selector matches inside open shadow roots too')
    .argument('[selector]', 'Role word + name (`wait-for button "Continue"`) or CSS selector')
    .argument('[name]', 'Accessible name when the first argument is a role word')
    .option('-s, --session <name>', 'Session name')
    .option('--exact', 'Match the accessible name exactly')
    .option('--text <text>', 'Wait until any of the given texts appears in document.body.innerText (comma-separated for any-of)')
    .option('--network-idle', 'Wait for network idle instead of a selector')
    .option('--timeout <ms>', 'Max wait time', intArg, 30000)
    .action(async (selector: string | undefined, name: string | undefined, opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        // role + 이름 — 나타날 때까지 a11y 트리를 묻는다. 모호해도 "나타났다" 는 참이다.
        if (selector && takesName(selector)) {
          const deadline = Date.now() + opts.timeout;
          const label = name === undefined ? selector : `${selector} "${name}"`;
          for (;;) {
            const cdp = await page.createCDPSession();
            let found: number;
            try { found = (await findByRoleName(cdp, axRole(selector), name, !!opts.exact)).length; } finally { await cdp.detach(); }
            if (found > 0) break;
            if (Date.now() >= deadline) throw new TirnoError(`Waiting for ${label} failed: ${opts.timeout}ms exceeded`, 'timeout', { role: selector, name });
            await new Promise(r => setTimeout(r, 200));
          }
          browser.disconnect();
          success(`Visible: ${label}`);
          return;
        }

        // The three forms are alternatives, not a priority list. Silently
        // ignoring the selector because --network-idle was also given makes the
        // command wait for something the caller did not ask about.
        const forms = [selector && 'selector', opts.text && '--text', opts.networkIdle && '--network-idle'].filter(Boolean);
        if (forms.length > 1) throw new Error(`Give one of: selector, --text, --network-idle (got ${forms.join(' + ')})`);

        if (opts.networkIdle) {
          await page.waitForNetworkIdle({ timeout: opts.timeout });
          browser.disconnect();
          success('Network idle');
          return;
        }
        if (opts.text) {
          const needles = opts.text.split(',').map((s: string) => s.trim()).filter(Boolean);
          if (needles.length === 0) throw new Error('--text needs at least one non-empty string');
          await page.waitForFunction(
            (texts: string[]) => {
              const body = document.body?.innerText ?? '';
              return texts.some(t => body.includes(t));
            },
            { timeout: opts.timeout, polling: 200 },
            needles,
          );
          browser.disconnect();
          success(`Text visible: ${needles.join(' | ')}`);
          return;
        }
        if (!selector) throw new Error('Provide a selector, --text, or --network-idle');
        // `pierce/` 는 document 도 순회하므로 light DOM 이 빠지지 않는다(실측).
        // 여기서는 어느 것을 고르느냐가 아니라 나타났느냐만 보므로 한 번에 기다린다.
        try {
          await page.waitForSelector(`pierce/${selector}`, { timeout: opts.timeout });
        } catch (e) {
          // 접두사가 붙은 채로 올라오면 사용자가 치지 않은 셀렉터가 에러에 나온다.
          throw new Error((e as Error).message.replace(`pierce/${selector}`, selector), { cause: e });
        }
        browser.disconnect();
        success(`Selector visible: ${selector}`);
      } catch (e) {
        fail(e);
      }
    });

  program
    .command('upload')
    .description('Upload files to a file input')
    .argument('<selector>', 'CSS selector for file input')
    .argument('<files...>', 'File paths to upload')
    .option('-s, --session <name>', 'Session name')
    .option(...DELTA_FLAG)
    .action(async (selector: string, files: string[], opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        const input = await page.$(selector);
        if (!input) throw new Error(`Element not found: ${selector}`);

        const { delta } = await actWithDelta(page, opts, () => input.uploadFile(...files));

        browser.disconnect();
        success(`Uploaded ${files.length} file(s) to ${selector}`);
        printDelta(delta);
      } catch (e) {
        fail(e);
      }
    });
}


