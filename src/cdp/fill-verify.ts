/**
 * `fill` 이 "됐다" 고 말하기 전에 요소가 실제로 그 값을 들고 있는지 본다 (#184).
 *
 * 타이핑은 신뢰할 수 있는 입력 이벤트를 내지만 **받아들여졌는지는 보장하지 않는다** —
 * readonly/disabled 는 키를 버리고, keydown 핸들러가 preventDefault 하면 글자가 안
 * 들어가고, maxlength 는 뒤를 자르고, 도중에 포커스가 옮겨가면 뒷글자가 다른 데 붙는다.
 * 이 넷 전부가 `keyboard.type` 을 예외 없이 끝낸다. 그래서 되읽는다.
 */

/** 페이지 안에서 `this` 로 실행된다. 직렬화 가능한 값만 돌려준다. */
export const READ_FIELD_STATE = `function(){
  const el = this;
  let active = el.ownerDocument.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  const editable = !!el.isContentEditable;
  return {
    value: editable ? (el.textContent ?? '') : ('value' in el ? String(el.value ?? '') : null),
    readOnly: !!el.readOnly,
    disabled: !!el.disabled,
    maxLength: typeof el.maxLength === 'number' ? el.maxLength : -1,
    type: typeof el.type === 'string' ? el.type : null,
    focused: active === el,
    tag: String(el.tagName || '').toLowerCase(),
    selectedLabel: el.tagName === 'SELECT' && el.selectedOptions && el.selectedOptions[0] ? (el.selectedOptions[0].label || el.selectedOptions[0].text) : null,
  };
}`;

export interface FieldState {
  /** null 이면 value 도 contenteditable 도 아닌 요소다 */
  value: string | null;
  readOnly: boolean;
  disabled: boolean;
  /** 미설정이면 -1 */
  maxLength: number;
  type: string | null;
  focused: boolean;
  tag: string;
  /** select 면 골라진 option 의 보이는 라벨 — value 와 라벨 어느 쪽으로도 맞을 수 있게 */
  selectedLabel?: string | null;
}

/**
 * 타이핑 **전에** 거절할 이유. 이때 걸러야 하는 것은 disabled 다 — `focus()` 가 no-op 이라
 * 키 입력이 **그때 포커스된 다른 요소**로 들어간다. 되읽기로는 "값이 안 들어갔다" 만
 * 알 뿐, 어디로 갔는지는 모른다.
 */
export function refuseBeforeTyping(target: string, s: FieldState): string | null {
  if (s.disabled) return `${target} is disabled — typing would land in whatever is focused instead`;
  if (s.readOnly) return `${target} is readonly — keystrokes are discarded`;
  if (s.value === null) return `${target} is <${s.tag}> — not an input, textarea, select or contenteditable`;
  return null;
}

/**
 * 타이핑 **뒤에** 값이 다를 때 그 이유를 최대한 짚는다. 원인을 못 짚으면 그렇다고
 * 말한다 — 그래도 "Filled" 보다는 낫다.
 *
 * `hideValue` 는 `--value-stdin` 경로다. argv 를 피해 넣은 값을 불일치 메시지에 도로
 * 싣지 않는다 — 길이만 적는다.
 */
export function describeMismatch(
  target: string, expected: string, s: FieldState, hideValue = false,
): string | null {
  const actual = s.value ?? '';
  if (actual === expected) return null;

  const show = (v: string) => hideValue ? `${v.length} chars` : JSON.stringify(v);
  const head = `fill ${target}: expected ${show(expected)} but element reads ${show(actual)}`;

  let why: string;
  if (s.maxLength >= 0 && expected.length > s.maxLength && actual === expected.slice(0, s.maxLength)) {
    why = `maxlength=${s.maxLength} cut it`;
  } else if (!s.focused) {
    why = 'focus left the element while typing — the rest went elsewhere';
  } else if (actual === '') {
    why = 'nothing was accepted — a keydown/beforeinput handler is likely calling preventDefault()';
  } else if (expected.startsWith(actual)) {
    why = 'input stopped partway — a handler rejected the rest';
  } else {
    why = 'an input handler rewrote the value (a formatter or mask). If that is intended, pass --no-verify';
  }
  return `${head} — ${why}`;
}
