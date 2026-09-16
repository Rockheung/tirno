/**
 * 세션 뱃지 — 창 위에 세션 이름을 붙인다.
 *
 * headful 세션 다섯이 같은 크기로 겹쳐 뜨면 어느 창이 어느 세션인지 알 길이 없다 —
 * 창 제목은 페이지 제목이고, 세션 이름은 화면 어디에도 없다. 그래서 페이지 안에 이름
 * 조각을 얹는다. 관측을 더럽히지 않는 조건 셋:
 *
 * 1. `aria-hidden` → a11y 트리에 없다 = snapshot · delta · 캐시 무영향
 * 2. 스크린샷을 찍기 직전 숨긴다(`Page.screenshot`) = 스크린샷 · 지문 무영향
 * 3. `position: fixed` = 레이아웃 · 좌표 무영향
 *
 * 닫힌 shadow root 안에 그려서 페이지 CSS 가 닿지 않고 페이지 스크립트가 `querySelector`
 * 로 만나지 않는다(호스트 요소 하나만 보인다). 끌어서 옮길 수 있고, 옮긴 자리는 origin
 * 마다 localStorage 에 남는다. 배경색은 세션을 만들 때 한 번 뽑아 대장에 적으므로 그
 * 세션이 사는 동안 같다.
 */

export const BADGE_ID = '__tirno_badge';

/** 채도·밝기를 묶어 두고 색상만 뽑는다 — 글자가 읽히는 범위 안에서 서로 다르게 */
export function randomBadgeColor(rand: () => number = Math.random): string {
  const h = Math.floor(rand() * 360);
  const s = 55 + Math.floor(rand() * 25);      // 55–80%
  const l = 32 + Math.floor(rand() * 18);      // 32–50% — 흰 글자가 읽힌다
  return `hsl(${h} ${s}% ${l}%)`;
}

/** `hsl(h s% l%)` → `#rrggbb` — 터미널(chalk.hex)에 같은 색 점을 찍기 위해 */
export function badgeColorHex(hsl: string): string | null {
  const m = /^hsl\((\d+)\s+(\d+)%\s+(\d+)%\)$/.exec(hsl);
  if (!m) return null;
  const h = Number(m[1]) / 360, s = Number(m[2]) / 100, l = Number(m[3]) / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const hex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${hex(f(h + 1 / 3))}${hex(f(h))}${hex(f(h - 1 / 3))}`;
}

/**
 * 페이지에 들어갈 스크립트. 멱등이고(두 번 들어가도 하나), body 가 통째로 갈리는 SPA 를
 * 위해 2초마다 붙어 있는지 본다. `window.__tirno_badge.hide()/show()` 를 남겨 스크린샷이
 * 쓴다.
 */
export function badgeInstallScript(session: string, color: string): string {
  const name = JSON.stringify(session);
  const bg = JSON.stringify(color);
  return `
  if (!window.__tirno_badge && window === window.top) {
    const ID = ${JSON.stringify(BADGE_ID)};
    const KEY = '__tirno_badge_pos';
    const api = { host: null, hide() { if (api.host) api.host.style.visibility = 'hidden'; }, show() { if (api.host) api.host.style.visibility = ''; } };
    window.__tirno_badge = api;
    const mount = () => {
      if (!document.body) return;
      if (document.getElementById(ID)) return;
      const host = document.createElement('div');
      host.id = ID;
      host.setAttribute('aria-hidden', 'true');
      host.setAttribute('role', 'presentation');
      host.setAttribute('data-tirno', 'badge');
      // 페이지 CSS 가 닿지 않게 all:initial, 그 위에 우리 것만
      host.style.cssText = 'all:initial; position:fixed; z-index:2147483647; top:8px; left:50%; transform:translateX(-50%); cursor:grab; user-select:none;';
      let pos = null;
      try { pos = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) {}
      if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
        host.style.left = pos.x + 'px'; host.style.top = pos.y + 'px'; host.style.transform = 'none';
      }
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = '<style>'
        + '.b{font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#fff;background:' + ${bg} + ';'
        + 'padding:5px 10px;border-radius:999px;box-shadow:0 1px 4px rgba(0,0,0,.35);letter-spacing:.02em;white-space:nowrap;opacity:.92}'
        + '.b::before{content:"tirno ";opacity:.7;font-weight:400}'
        + '</style><div class="b"></div>';
      root.querySelector('.b').textContent = ${name};
      // 끌기 — mousedown 에서 잡고 window 에서 따라간다. 옮긴 자리는 origin 마다 남긴다.
      let drag = null;
      host.addEventListener('mousedown', (e) => {
        const r = host.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        host.style.cursor = 'grabbing';
        e.preventDefault();
      });
      window.addEventListener('mousemove', (e) => {
        if (!drag) return;
        const x = Math.max(0, Math.min(window.innerWidth - 40, e.clientX - drag.dx));
        const y = Math.max(0, Math.min(window.innerHeight - 20, e.clientY - drag.dy));
        host.style.left = x + 'px'; host.style.top = y + 'px'; host.style.transform = 'none';
      }, true);
      window.addEventListener('mouseup', () => {
        if (!drag) return;
        drag = null;
        host.style.cursor = 'grab';
        const r = host.getBoundingClientRect();
        try { localStorage.setItem(KEY, JSON.stringify({ x: r.left, y: r.top })); } catch (_) {}
      }, true);
      document.body.appendChild(host);
      api.host = host;
    };
    if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
    setInterval(mount, 2000);
  }
  `;
}
