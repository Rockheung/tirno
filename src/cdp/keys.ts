/**
 * `Meta+v` 같은 조합 표기를 CDP 가 받는 모양으로 옮긴다.
 *
 * 조합이 곧 기능인 조작 — 붙여넣기·전체선택·실행취소 — 은 키 이벤트만 보내서는
 * 일어나지 않는다. `Input.dispatchKeyEvent` 에 `commands` 를 함께 실어야 편집기가
 * 실제로 그 동작을 한다(실측: commands 없이 Meta+V 는 값이 그대로였다).
 */

export interface KeyCombo {
  /** 정규화된 수식키 — 'Alt' | 'Control' | 'Meta' | 'Shift' */
  modifiers: string[];
  /** 마지막 조각. 문자 하나이거나 'Tab' 같은 이름 */
  key: string;
}

const MODIFIER_ALIASES: Record<string, string> = {
  alt: 'Alt', option: 'Alt',
  ctrl: 'Control', control: 'Control',
  meta: 'Meta', cmd: 'Meta', command: 'Meta', super: 'Meta',
  shift: 'Shift',
};

/** CDP `modifiers` 비트. Alt 1 · Control 2 · Meta 4 · Shift 8. */
const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

/**
 * 마지막 `+` 뒤가 키다. 앞은 전부 수식키여야 한다.
 *
 * 뒤에서부터 자르는 이유는 키 자체가 `+` 일 수 있기 때문이다 — `Shift++` 는
 * 수식키 Shift 와 키 `+` 다. 앞에서 쪼개면 빈 키가 나온다.
 */
export function parseKeyCombo(input: string): KeyCombo {
  let cut = input.lastIndexOf('+');
  // 마지막 `+` 가 문자열 끝이면 그것이 키다 — 구분자는 그 앞의 `+`.
  if (cut > 0 && cut === input.length - 1) cut = input.lastIndexOf('+', cut - 1);
  if (cut <= 0) return { modifiers: [], key: input };

  const key = input.slice(cut + 1);
  const rawMods = input.slice(0, cut).split('+');
  if (key === '') throw new Error(`Missing key after "+" in "${input}"`);

  const modifiers: string[] = [];
  for (const raw of rawMods) {
    const norm = MODIFIER_ALIASES[raw.trim().toLowerCase()];
    if (!norm) throw new Error(`Unknown modifier "${raw}" in "${input}" — use Alt, Ctrl, Meta, or Shift`);
    if (!modifiers.includes(norm)) modifiers.push(norm);
  }
  return { modifiers, key };
}

export function modifierBits(modifiers: string[]): number {
  return modifiers.reduce((n, m) => n | (MODIFIER_BITS[m] ?? 0), 0);
}

/**
 * 이 조합이 편집 명령인가.
 *
 * 플랫폼 관례(mac 은 Meta, 그 외는 Control)를 따지지 않고 둘 다 받는다. `commands`
 * 는 브라우저에 그 동작을 하라고 직접 말하는 것이라 관례와 무관하게 먹고, 부르는
 * 쪽은 이미 자기 의도를 적었다.
 */
export function editingCommandFor(combo: KeyCombo): string | null {
  const { modifiers, key } = combo;
  const primary = modifiers.includes('Meta') || modifiers.includes('Control');
  if (!primary || modifiers.includes('Alt')) return null;

  const shift = modifiers.includes('Shift');
  switch (key.toLowerCase()) {
    case 'v': return shift ? null : 'paste';
    case 'c': return shift ? null : 'copy';
    case 'x': return shift ? null : 'cut';
    case 'a': return shift ? null : 'selectAll';
    // mac 은 Meta+Shift+Z, 그 밖은 Ctrl+Y 로 다시 실행한다. 둘 다 받는다.
    case 'z': return shift ? 'redo' : 'undo';
    case 'y': return shift ? null : 'redo';
    default: return null;
  }
}

/**
 * 편집 명령에 쓰이는 키의 `windowsVirtualKeyCode`.
 *
 * 전체 키보드 표를 들지 않는 이유는 여기 오는 키가 여섯 개뿐이기 때문이다.
 * 나머지 조합은 puppeteer 가 자기 표로 눌러 준다.
 */
export function virtualKeyCode(key: string): number {
  return key.toUpperCase().charCodeAt(0);
}

/** `v` → `KeyV`. 편집 명령 키는 전부 문자다. */
export function keyCodeName(key: string): string {
  return `Key${key.toUpperCase()}`;
}
