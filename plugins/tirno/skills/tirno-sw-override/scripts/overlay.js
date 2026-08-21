// tirno sw-proxy — 페이지 안에서 무엇이 덮여 있는지 보는 창. 생성된 파일.
//
// **이 창이 보인다는 것은 서비스워커가 살아서 응답하고 있다는 뜻이다.** 그 보증은
// 검사가 아니라 구조에서 나온다 — 이 스크립트는 워커의 control 경로가 no-store 로
// 내는 것이라, 워커가 없으면 태그가 404 를 받고 아무 일도 일어나지 않는다. HTML 에
// 이 태그가 들어 있는 것도 워커의 캐시에서 나왔기 때문이고, 워커가 죽으면 origin 의
// 원본 HTML 이 와서 태그 자체가 없다.
//
// 구조가 막지 못하는 것은 하나뿐이다 — 뜬 뒤에 워커가 죽는 경우. 그래서 아래에서
// 컨트롤러를 감시하고, 끊기면 창을 지운다. 죽은 워커 위에 남은 창은 없느니만 못하다.
//
// 보기 전용이다. 레이어를 켜고 끄는 것은 `<scope>__tirno/mount|unmount` 가 하고,
// 여기서는 부르지 않는다 — 확인하러 연 창이 상태를 바꾸면 확인이 아니게 된다.
(() => {
  const SCOPE = typeof __TIRNO_SCOPE__ === 'string' ? __TIRNO_SCOPE__ : '/';
  const HOST_ID = 'tirno-overlay-host';
  const sw = navigator.serviceWorker;

  // ── 생존 조건. 하나라도 어긋나면 DOM 을 건드리지 않고 끝낸다.
  //
  // controller 가 정본이다. 등록(registration)이 남아 있어도 이 문서를 제어하지
  // 않으면 이 문서의 요청은 워커로 가지 않는다 — 그 상태에서 창이 떠 있으면
  // "덮여 있다" 는 거짓말이 된다. 첫 로드처럼 등록만 되고 아직 claim 되지 않은
  // 문서가 정확히 그 경우다.
  if (!sw || !sw.controller) return;
  if (document.getElementById(HOST_ID)) return;      // 문서가 두 번 실려도 하나만

  const worker = sw.controller;
  let dead = false;
  const listeners = [];
  const on = (target, type, fn) => { target.addEventListener(type, fn); listeners.push([target, type, fn]); };

  let pulse = 0;
  function die() {
    if (dead) return;
    dead = true;
    clearInterval(pulse);
    for (const [t, type, fn] of listeners) t.removeEventListener(type, fn);
    listeners.length = 0;
    host.remove();
  }

  const KEY = 'tirno-overlay:' + SCOPE;
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
  })();
  const save = patch => {
    Object.assign(saved, patch);
    try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* 차단됨 */ }
  };

  const host = document.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'open' });

  // 워커가 뜬 뒤에 죽는 세 갈래를 각각 잡는다. 폴링하지 않는 이유는 유휴 종료된
  // 워커도 fetch 하나면 깨어나기 때문이다 — 깨워 놓고 "살아 있다" 고 하는 것은
  // 관측이 아니라 개입이다.
  on(worker, 'statechange', () => { if (worker.state === 'redundant') die(); });
  on(sw, 'controllerchange', () => { if (!sw.controller) die(); });
  on(window, 'pageshow', () => { if (!sw.controller || worker.state === 'redundant') die(); });

  // 네 번째 갈래는 이벤트로 오지 않는다: `unregister()` 는 등록만 지우고, 이미 제어
  // 중인 문서는 리로드 전까지 계속 제어된다 — 그래서 controllerchange 도
  // statechange 도 오지 않고 창은 멀쩡히 남는다(실측). 그 상태의 창은 "덮여 있다"
  // 를 새로고침 뒤에도 참일 것처럼 읽게 만든다. 그래서 등록 자체를 본다.
  //
  // fetch 가 아니라 등록 조회다. 유휴 종료된 워커를 깨우지 않으므로, 살아 있는지
  // 물어보느라 살려 놓는 일이 없다.
  const check = async () => {
    if (dead) return;
    let reg = null;
    try { reg = await sw.getRegistration(); } catch { /* 조회 실패도 없는 것으로 본다 */ }
    if (dead) return;
    if (!reg || !sw.controller) die();
  };
  pulse = setInterval(check, 2000);
  on(document, 'visibilitychange', () => { if (!document.hidden) check(); });

  root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .wrap {
    position: fixed; z-index: 2147483647; top: 0; left: 0;
    display: flex; flex-direction: column; align-items: flex-start;
    color: #e6e6e6; font-size: 12px; line-height: 1.5;
  }
  /* 배지는 내용 크기다. 패널이 열려 있는 동안 wrap 이 패널 폭(380)을 갖는데,
     블록으로 두면 배지가 거기까지 늘어나 손잡이로 보이지 않는다. */
  .wrap.right { align-items: flex-end; }
  .tab {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 10px; border-radius: 6px; cursor: grab;
    background: #17181c; border: 1px solid #33353c;
    box-shadow: 0 2px 12px rgba(0,0,0,.45);
    user-select: none; white-space: nowrap; touch-action: none;
  }
  .tab:active { cursor: grabbing; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #4ac26b; flex: none; }
  .panel {
    margin-top: 6px; width: 380px; max-height: 60vh; overflow: auto;
    background: #17181c; border: 1px solid #33353c; border-radius: 8px;
    box-shadow: 0 6px 28px rgba(0,0,0,.5); padding: 10px 12px;
  }
  .panel[hidden] { display: none; }
  .meta { color: #8b8f99; margin-bottom: 8px; word-break: break-all; }
  .layer { margin-top: 10px; }
  .layer:first-of-type { margin-top: 0; }
  .row { display: flex; align-items: baseline; gap: 6px; cursor: pointer; }
  .row:hover > .label { color: #fff; }
  .caret { width: 10px; flex: none; color: #8b8f99; }
  .label { color: #cdd0d6; word-break: break-all; }
  .layer > .row > .label { color: #7fc8ff; }
  .off > .row > .label { color: #8b8f99; text-decoration: line-through; }
  .count { color: #8b8f99; flex: none; margin-left: auto; padding-left: 8px; }
  .kids { margin-left: 12px; border-left: 1px solid #2a2c33; padding-left: 8px; }
  .kids[hidden] { display: none; }
  .leaf { color: #b9bdc6; word-break: break-all; padding-left: 16px; }
  .empty { color: #8b8f99; }
</style>
<div class="wrap">
  <div class="tab"><span class="dot"></span><span class="tab-text">sw</span></div>
  <div class="panel" hidden></div>
</div>`;

  (document.body || document.documentElement).appendChild(host);

  const wrap = root.querySelector('.wrap');
  const tab = root.querySelector('.tab');
  const tabText = root.querySelector('.tab-text');
  const panel = root.querySelector('.panel');

  // ── 위치. 놓으면 가까운 세로 가장자리에 붙는다. 창 크기가 바뀌어도 자리를 지키도록
  //    비율이 아니라 "어느 쪽 + 위에서 얼마" 로 들고 있는다.
  let pos = {
    side: saved.side === 'right' ? 'right' : 'left',
    top: typeof saved.top === 'number' ? saved.top : 120,
  };

  function place() {
    const h = wrap.offsetHeight || 30;
    wrap.style.top = Math.max(4, Math.min(pos.top, window.innerHeight - h - 4)) + 'px';
    wrap.style.left = pos.side === 'right' ? 'auto' : '8px';
    wrap.style.right = pos.side === 'right' ? '8px' : 'auto';
    wrap.classList.toggle('right', pos.side === 'right');
  }

  let drag = null;
  on(tab, 'pointerdown', e => {
    if (e.button !== 0) return;
    const r = wrap.getBoundingClientRect();
    drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
    tab.setPointerCapture(e.pointerId);
  });
  on(tab, 'pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.abs(e.movementX) + Math.abs(e.movementY) < 2) return;
    drag.moved = true;
    wrap.style.left = (e.clientX - drag.dx) + 'px';
    wrap.style.right = 'auto';
    wrap.style.top = (e.clientY - drag.dy) + 'px';
  });
  on(tab, 'pointerup', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const wasDrag = drag.moved;
    drag = null;
    if (!wasDrag) return toggle();                   // 안 움직였으면 클릭이다
    const r = wrap.getBoundingClientRect();
    pos = { side: r.left + r.width / 2 > window.innerWidth / 2 ? 'right' : 'left', top: r.top };
    save({ side: pos.side, top: pos.top });
    place();
  });
  on(window, 'resize', place);

  function toggle() {
    const open = panel.hidden;
    panel.hidden = !open;
    save({ open });
    if (open) refresh();
  }

  // ── 데이터. 캐시가 정본이고, control 응답이 레이어 이름과 served 를 얹는다.
  //    control 이 답하지 않으면 워커가 이 창을 낸 그 워커가 아니라는 뜻이므로 창을
  //    지운다 — 남겨 두면 다른 워커의 캐시를 이 워커의 것처럼 보여주게 된다.
  async function collect() {
    const res = await fetch(SCOPE + '__tirno/status', { cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) throw new Error('control gone');
    const body = await res.json();

    const layers = new Map();
    for (const l of body.layers || []) layers.set(l.id, l);

    const entries = [];
    for (const name of await caches.keys()) {
      const c = await caches.open(name);
      const reqs = await c.keys();
      entries.push({
        name,
        layerId: name.startsWith('tirno-sw:') ? name.split(':').slice(2).join(':') : null,
        paths: reqs.map(q => new URL(q.url).pathname).sort(),
      });
    }
    return { buildId: body.buildId || null, layers, caches: entries };
  }

  // 경로를 디렉터리로 접는다. 129개를 평면으로 쏟으면 읽을 수 없다.
  //
  // 마운트 접두사는 뗀다 — 레이어 머리에 이미 적혀 있고, `/_/widget-studio/` 같은
  // 접두사가 모든 가지에 되풀이되면 정작 다른 부분이 안 보인다. 파일 하나짜리
  // 마운트는 떼면 남는 게 없으므로 그대로 둔다.
  function tree(paths, prefix) {
    const node = { dirs: new Map(), files: [] };
    for (const full of paths) {
      const rel = prefix && full.startsWith(prefix) ? full.slice(prefix.length) : full;
      const p = rel || full;
      const parts = p.replace(/^\//, '').split('/');
      const file = parts.pop();
      let cur = node;
      for (const d of parts) {
        if (!cur.dirs.has(d)) cur.dirs.set(d, { dirs: new Map(), files: [] });
        cur = cur.dirs.get(d);
      }
      cur.files.push(file || '/');
    }
    return node;
  }

  function countOf(node) {
    let n = node.files.length;
    for (const d of node.dirs.values()) n += countOf(d);
    return n;
  }

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function foldable(labelText, count, cls, collapsed) {
    const box = el('div', cls);
    const row = el('div', 'row');
    const caret = el('span', 'caret', collapsed ? '▸' : '▾');
    row.append(caret, el('span', 'label', labelText), el('span', 'count', String(count)));
    const kids = el('div', 'kids');
    kids.hidden = collapsed;
    row.addEventListener('click', ev => {
      ev.stopPropagation();
      kids.hidden = !kids.hidden;
      caret.textContent = kids.hidden ? '▸' : '▾';
    });
    box.append(row, kids);
    return { box, kids };
  }

  function renderNode(node, into, depth) {
    for (const [name, kid] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
      const { box, kids } = foldable(name + '/', countOf(kid), null, depth >= 1);
      renderNode(kid, kids, depth + 1);
      into.append(box);
    }
    for (const f of node.files.sort()) into.append(el('div', 'leaf', f));
  }

  async function refresh() {
    if (dead) return;
    panel.textContent = '';
    panel.append(el('div', 'meta', '읽는 중…'));

    let data;
    try {
      data = await collect();
    } catch {
      die();                                          // 워커가 응답하지 않는다 → 지표가 거짓이 된다
      return;
    }
    if (dead) return;

    panel.textContent = '';
    const total = data.caches.reduce((n, c) => n + c.paths.length, 0);
    tabText.textContent = 'sw ' + total;
    panel.append(el('div', 'meta',
      `${location.origin} · scope ${SCOPE}` +
      (data.buildId ? ` · build ${data.buildId}` : '') + ` · ${total} paths`));

    if (!data.caches.length) {
      panel.append(el('div', 'empty', '이 origin 에 캐시가 없다 — 아무것도 덮이지 않았다.'));
      return;
    }

    for (const c of data.caches) {
      const meta = c.layerId ? data.layers.get(c.layerId) : null;
      const title = meta ? `${meta.name}  ${meta.mount || ''}`.trim() : c.name;
      const offCls = 'layer' + (meta && meta.enabled === false ? ' off' : '');
      const { box, kids } = foldable(title, c.paths.length, offCls, false);
      if (meta) {
        const bits = [];
        if (meta.enabled === false) bits.push('꺼짐');
        if (typeof meta.served === 'number') bits.push(`served ${meta.served}`);
        if (meta.from) bits.push(`← ${meta.from}`);
        if (bits.length) kids.append(el('div', 'meta', bits.join(' · ')));
      }
      renderNode(tree(c.paths, meta && meta.mount), kids, 0);
      panel.append(box);
    }
  }

  place();
  panel.hidden = !saved.open;
  refresh();          // 닫혀 있어도 배지의 경로 수는 맞아야 하고, 생존도 여기서 재확인된다
})();
