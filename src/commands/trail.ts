import { Command } from 'commander';
import { intArg, floatArg } from '../util/parsers.js';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import * as trailStore from '../core/trail-store.js';
import type { RecordedEvent } from '../core/record-store.js';
import { formatTable, success, info, error } from '../output/formatter.js';
import { emit as metric } from '../core/metrics.js';
import type { Page } from 'puppeteer-core';

interface ClientRecState {
  events: RecordedEvent[];
  recording: boolean;
  startTs: number;
}

interface ResolvedTarget {
  x: number;
  y: number;
  channel: 'dom' | 'a11y' | 'visual.bbox' | 'event.xy';
}

async function resolveTarget(page: Page, ev: RecordedEvent): Promise<ResolvedTarget | null> {
  const ch = ev.channels ?? {};
  const sel = ch.dom?.selector ?? ev.sel ?? null;
  if (sel) {
    const xy = await page.evaluate((s: string) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
    }, sel).catch(() => null);
    if (xy) return { x: xy[0], y: xy[1], channel: 'dom' };
  }
  const role = ch.a11y?.role;
  const name = ch.a11y?.name;
  if (role && name) {
    const xy = await page.evaluate(({ r, n }: { r: string; n: string }) => {
      for (const el of document.querySelectorAll('*')) {
        const elRole = el.getAttribute('role') ||
          (el.tagName === 'A' && el.hasAttribute('href') ? 'link' :
           el.tagName === 'BUTTON' ? 'button' :
           el.tagName === 'INPUT' ? (el.getAttribute('type') === 'submit' || el.getAttribute('type') === 'button' ? 'button' : 'textbox') :
           el.tagName === 'TEXTAREA' ? 'textbox' :
           el.tagName === 'SELECT' ? 'combobox' :
           el.tagName.toLowerCase());
        if (elRole !== r) continue;
        const elName = el.getAttribute('aria-label') ||
                       el.getAttribute('alt') ||
                       el.getAttribute('title') ||
                       (el.textContent || '').trim().slice(0, 80);
        if (elName !== n) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        return [Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2)];
      }
      return null;
    }, { r: role, n: name }).catch(() => null);
    if (xy) return { x: xy[0], y: xy[1], channel: 'a11y' };
  }
  const bbox = ch.visual?.bbox ?? ev.bbox ?? null;
  if (bbox) {
    const cx = Math.round(bbox.x + bbox.w / 2);
    const cy = Math.round(bbox.y + bbox.h / 2);
    const ok = await page.evaluate(({ x, y }: { x: number; y: number }) => {
      return !!document.elementFromPoint(x, y);
    }, { x: cx, y: cy }).catch(() => false);
    if (ok) return { x: cx, y: cy, channel: 'visual.bbox' };
  }
  if (typeof ev.x === 'number' && typeof ev.y === 'number') {
    return { x: ev.x, y: ev.y, channel: 'event.xy' };
  }
  return null;
}

export function registerTrailCommands(program: Command): void {
  const trail = program
    .command('trail')
    .description(
      'Trail = goal에 도달하는 행동 시퀀스. 메인 흐름은 자율 탐색 (cache + multi-channel + LLM). ' +
      'capture는 그 모두가 실패했을 때만 사용자에게 시연 받는 마지막 fallback.'
    );

  trail
    .command('capture <name>')
    .description('[fallback only] 사용자 시연 캡처. 자율 탐색이 모두 실패한 케이스에서만 사용. record listener 활성화.')
    .argument('<name>', 'Trail name (used for filename + replay key)')
    .option('-s, --session <name>', 'Session name')
    .option('--goal <description>', 'Human-readable goal description')
    .action(async (name: string, opts) => {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(name)) {
          throw new Error('Trail name must match [A-Za-z0-9_-]+');
        }
        info('⚠ user-demo capture mode — only as fallback when autonomous exploration fails.');
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);
        await page.evaluate(() => {
          const w = window as unknown as { __tirno_rec: ClientRecState; __tirno_rec_flush?: () => void };
          if (!w.__tirno_rec) throw new Error('record install missing — reconnect session');
          w.__tirno_rec.events = [];
          w.__tirno_rec.startTs = Date.now();
          w.__tirno_rec.recording = true;
          if (w.__tirno_rec_flush) w.__tirno_rec_flush();
        });
        const url = page.url();
        browser.disconnect();

        trailStore.setActive({
          name,
          goal: opts.goal ?? name,
          startUrl: url,
          startedAt: new Date().toISOString(),
        });
        success(`Trail "${name}" recording — goal: ${opts.goal ?? name}`);
        info(`Interact with the page, then "tirno trail save".`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  trail
    .command('save')
    .description('[fallback only] Stop user-demo capture and save')
    .option('-s, --session <name>', 'Session name')
    .option('--name <override>', 'Override the trail name set at start')
    .action(async (opts) => {
      try {
        const active = trailStore.getActive();
        if (!active && !opts.name) throw new Error('No active trail. Use "tirno trail start <name>" first.');

        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);
        const result = await page.evaluate(() => {
          const w = window as unknown as { __tirno_rec: ClientRecState; __tirno_rec_flush?: () => void };
          if (!w.__tirno_rec) return null;
          w.__tirno_rec.recording = false;
          const events = w.__tirno_rec.events.slice();
          w.__tirno_rec.events = [];
          w.__tirno_rec.startTs = 0;
          if (w.__tirno_rec_flush) w.__tirno_rec_flush();
          try { localStorage.removeItem('__tirno_rec_state'); } catch { /* ignore */ }
          return {
            events,
            durationMs: events.length > 0 ? events[events.length - 1].t : 0,
          };
        });
        browser.disconnect();
        if (!result) throw new Error('No record state on page');

        const name = opts.name ?? active!.name;
        trailStore.save({
          name,
          goal: active?.goal ?? name,
          startUrl: active?.startUrl ?? page.url(),
          capturedAt: new Date().toISOString(),
          durationMs: result.durationMs,
          steps: result.events.map((event: RecordedEvent) => ({ event })),
        });
        trailStore.clearActive();
        success(`Saved trail "${name}" — ${result.events.length} events, ${result.durationMs}ms`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  trail
    .command('list')
    .description('List saved trails')
    .action(() => {
      try {
        const all = trailStore.list();
        if (all.length === 0) { info('No trails'); return; }
        console.log(formatTable(['NAME', 'GOAL', 'STEPS', 'DURATION', 'RUNS', 'CAPTURED'],
          all.map(t => [
            t.name,
            t.goal.length > 30 ? t.goal.slice(0, 27) + '...' : t.goal,
            String(t.steps.length),
            `${t.durationMs}ms`,
            t.matchStats ? `${t.matchStats.successCount}/${t.matchStats.runCount}` : '-',
            t.capturedAt.replace('T', ' ').slice(0, 19),
          ])
        ));
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  trail
    .command('show <name>')
    .description('Show trail steps with channel info')
    .action((name) => {
      try {
        const t = trailStore.load(name);
        console.log(`# trail: ${t.name}`);
        console.log(`# goal: ${t.goal}`);
        console.log(`# url:  ${t.startUrl}`);
        console.log(`# captured: ${t.capturedAt} (${t.durationMs}ms total)`);
        if (t.matchStats) {
          console.log(`# runs: ${t.matchStats.successCount}/${t.matchStats.runCount} success, lastRun ${t.matchStats.lastRunAt ?? '-'}`);
          if (t.matchStats.successByChannel) {
            const breakdown = Object.entries(t.matchStats.successByChannel).map(([k, v]) => `${k}:${v}`).join(' ');
            console.log(`# channel hits: ${breakdown}`);
          }
        }
        console.log('');
        for (let i = 0; i < t.steps.length; i++) {
          const s = t.steps[i];
          const e = s.event;
          const ch = e.channels ?? {};
          const channels: string[] = [];
          if (ch.dom?.selector) channels.push(`dom:${ch.dom.selector}`);
          if (ch.a11y?.role) channels.push(`a11y:${ch.a11y.role}${ch.a11y.name ? `="${ch.a11y.name.slice(0, 30)}"` : ''}`);
          if (ch.visual?.bbox) channels.push(`bbox:(${ch.visual.bbox.x},${ch.visual.bbox.y} ${ch.visual.bbox.w}x${ch.visual.bbox.h})`);
          const value = e.value ? ` value="${(e.value || '').slice(0, 30)}"` : '';
          const key = e.key ? ` key=${e.key}` : '';
          console.log(`${String(i + 1).padStart(3)}. +${e.t.toString().padStart(5)}ms  ${e.type.padEnd(8)}${value}${key}  [${channels.join(', ')}]`);
        }
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  trail
    .command('replay <name>')
    .description('Replay trail with multi-channel fallback')
    .option('-s, --session <name>', 'Session name')
    .option('--speed <n>', 'Playback speed multiplier', floatArg, 1.0)
    .option('--max-gap <ms>', 'Cap inter-step delay', intArg, 500)
    .option('--no-nav', 'Skip navigating to startUrl first')
    .option('--verbose', 'Print which channel matched per step')
    .action(async (name: string, opts) => {
      try {
        const t = trailStore.load(name);
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        if (opts.nav !== false && page.url() !== t.startUrl) {
          info(`Navigating to ${t.startUrl}`);
          await page.goto(t.startUrl, { waitUntil: 'domcontentloaded' });
        }

        const cdp = await page.createCDPSession();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const send = cdp.send.bind(cdp) as any;

        const speed = Math.max(0.01, opts.speed);
        const maxGap = opts.maxGap;
        let lastT = 0;
        let count = 0;
        const channelStats: Record<string, number> = {};

        for (let i = 0; i < t.steps.length; i++) {
          const ev = t.steps[i].event;
          const gap = Math.min(maxGap, Math.max(0, (ev.t - lastT) / speed));
          if (gap > 0) await new Promise(r => setTimeout(r, gap));
          lastT = ev.t;

          if (ev.type === 'click') {
            const target = await resolveTarget(page, ev);
            if (target) {
              await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y });
              await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
              await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
              channelStats[target.channel] = (channelStats[target.channel] ?? 0) + 1;
              if (opts.verbose) info(`step ${i + 1}: click via ${target.channel} → (${target.x},${target.y})`);
              count++;
            } else if (opts.verbose) {
              info(`step ${i + 1}: click skipped — no channel resolvable`);
            }
          } else if (ev.type === 'keydown' && ev.key) {
            const isPrintable = ev.key.length === 1;
            const down = isPrintable ? { type: 'keyDown', key: ev.key, text: ev.key } : { type: 'keyDown', key: ev.key };
            await send('Input.dispatchKeyEvent', down);
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ev.key });
            count++;
          } else if (ev.type === 'input' && ev.value !== undefined && ev.value !== null) {
            const sel = ev.channels?.dom?.selector ?? ev.sel;
            if (sel) {
              await page.evaluate((s: string, v: string) => {
                const el = document.querySelector(s) as HTMLInputElement | null;
                if (el) {
                  el.value = v;
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }
              }, sel, ev.value).catch(() => {});
              count++;
            }
          } else if (ev.type === 'scroll' && typeof ev.y === 'number') {
            await page.evaluate((y: number) => window.scrollTo({ top: y, behavior: 'instant' as ScrollBehavior }), ev.y);
            count++;
          }
        }

        await cdp.detach();
        browser.disconnect();

        const success_ok = count === t.steps.length;
        trailStore.recordRun(name, success_ok, channelStats);
        metric('trail.replay', { name, goal: t.goal, steps: t.steps.length, executed: count, success: success_ok, channelStats });

        const breakdown = Object.entries(channelStats).map(([k, v]) => `${k}:${v}`).join(' ');
        success(`Replayed trail "${name}" — ${count}/${t.steps.length} steps at ${speed}x${breakdown ? ` [${breakdown}]` : ''}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  trail
    .command('rm <name>')
    .description('Delete a trail')
    .action((name) => {
      try {
        trailStore.remove(name);
        success(`Removed trail "${name}"`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}
