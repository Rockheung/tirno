/**
 * a11y 트리를 줄로 편다 — `snapshot` 과 행동 뒤 delta(#209) 가 같은 렌더러를 쓴다.
 * `inspect.ts` 에서 꺼낸 것이고 동작은 그대로다.
 */
export interface AXValue { value?: string | number | boolean }
export interface AXProperty { name: string; value: AXValue }
export interface AXNode {
  nodeId: string;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  description?: AXValue;
  ignored?: boolean;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
  properties?: AXProperty[];
}

export interface DetailedRef {
  backendId: number;
  role: string;
  name: string;
}

/**
 * a11y 트리를 줄로 편다.
 *
 * `snapshot` 은 이 도구의 핵심 자산이지만, 전체 트리를 그대로 내면 출력이 에이전트
 * 컨텍스트를 두 방향으로 태운다 (#135):
 *
 * 1. **`InlineTextBox` 가 바로 위 `StaticText` 를 그대로 복창한다.** `@ref` 도 안 붙는다
 *    (= 조작 대상이 아니다). 텍스트가 긴 페이지에서 출력이 2배가 되고, 줄바꿈된 텍스트는
 *    InlineTextBox 가 여러 개로 쪼개지므로 2배보다 더 나빠진다. 얻는 정보는 0이다.
 * 2. **이름 없는 `generic` 이 앞을 다 채운다.** instagram 게시물에서는 조작 가능한 첫
 *    요소까지 generic 만 21줄이었다. 이름도 역할값도 없는 순수 레이아웃 컨테이너다.
 *
 * 2번의 손해는 줄 수만이 아니다 — **`@ref` 번호를 먹는다.** 의미 있는 요소의 ref 가 뒤로
 * 밀리면 "@7 을 눌러라" 가 페이지 구조 변화에 더 민감해진다. 그래서 접는 노드는 줄만
 * 안 내는 것이 아니라 번호도 안 받는다: 번호는 실제로 남는 것에만 간다.
 *
 * `--verbose` 는 전부 그대로 낸다. chrome-devtools-mcp / playwright 의 a11y snapshot 도
 * 같은 이유로 generic 컨테이너를 떨어뜨린다.
 */

/** 접힌 뒤 실제로 출력될 노드. 원본 AXNode 와 1:1 이 아니다. */
interface RenderNode {
  role: string;
  name: string;
  value?: string;
  states?: string[];
  interactive?: boolean;
  backendId?: number;
  children: RenderNode[];
}

export interface FoldStats {
  /** 부모 StaticText 와 같은 내용이라 안 낸 줄. */
  inlineTextBox: number;
  /** 이름도 역할값도 없어서 자식으로 대체한 컨테이너. */
  bareGeneric: number;
}

const GENERIC_ROLES = new Set(['generic', 'none', 'presentation', 'GenericContainer']);

function isFocusable(node: AXNode): boolean {
  return node.properties?.some(p => p.name === 'focusable' && p.value?.value === true) ?? false;
}

/**
 * 접기 판정. `keep` 이면 그 노드가 한 줄이 되고, 아니면 자식들이 그 자리를 대신한다.
 *
 * 이름도 역할값도 없는 컨테이너라도 **자식이 둘 이상이면 남긴다** — 그때는 묶음이라는
 * 사실 자체가 정보다. 접는 것은 통과용 래퍼(자식 0~1개)뿐이다.
 *
 * focusable 인 generic 은 이름이 없어도 남긴다. a11y 이름이 없는 클릭 가능한 div 는
 * 흔하고, 그것을 접으면 조작 대상이 출력에서 사라진다 — 이 명령이 존재하는 이유가
 * 그 대상을 찾는 것이다.
 */
function foldsAway(node: AXNode, role: string, name: string, hasValue: boolean, childCount: number): boolean {
  if (!GENERIC_ROLES.has(role)) return false;
  if (name || hasValue) return false;
  if (isFocusable(node)) return false;
  return childCount <= 1;
}

/** 사람이 조작할 수 있는 role — `snapshot --interactive` 가 남기는 것 */
export const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem',
]);

export function renderAXTree(
  nodes: AXNode[],
  skipIgnored: boolean,
  fold = true,
  rootBackendId?: number,
  opts: { interactiveOnly?: boolean } = {},
): { lines: string[]; refs: { [k: string]: DetailedRef }; folded: FoldStats } {
  const byId = new Map<string, AXNode>();
  for (const n of nodes) byId.set(n.nodeId, n);
  const root = (rootBackendId !== undefined ? nodes.find(n => n.backendDOMNodeId === rootBackendId) : undefined)
    ?? nodes.find(n => !n.parentId) ?? nodes[0];
  const folded: FoldStats = { inlineTextBox: 0, bareGeneric: 0 };

  /** 한 AXNode 가 0개(접힘)·1개·여러 개(접히며 자식 승격)의 RenderNode 가 된다. */
  function build(node: AXNode): RenderNode[] {
    const children = (node.childIds ?? [])
      .map(id => byId.get(id))
      .filter((c): c is AXNode => c !== undefined)
      .flatMap(build);

    // 원래 있던 동작: ignored 는 안 내되 자식은 그 깊이로 올라온다.
    if (skipIgnored && node.ignored) return children;

    const role = String(node.role?.value ?? '?');
    const name = node.name?.value ? String(node.name.value) : '';
    const hasValue = node.value?.value !== undefined;

    if (fold && role === 'InlineTextBox') {
      folded.inlineTextBox++;
      return children;
    }
    if (fold && foldsAway(node, role, name, hasValue, children.length)) {
      folded.bareGeneric++;
      return children;
    }

    const out: RenderNode = { role, name, children };
    // 조작 가능 — role 로, 또는 이름 없는 div 라도 focusable 이면
    if (INTERACTIVE_ROLES.has(role) || (isFocusable(node) && GENERIC_ROLES.has(role))) out.interactive = true;
    if (hasValue) out.value = JSON.stringify(node.value!.value);
    // 상태 — checked · expanded · disabled. 체크박스는 value 가 없어 이것 없이는 켜고 끈 것이
    // 스냅샷에도 delta 에도 안 보였다
    const states: string[] = [];
    for (const p of node.properties ?? []) {
      if (p.name === 'checked' && (p.value?.value === true || p.value?.value === 'true')) states.push('checked');
      if (p.name === 'checked' && p.value?.value === 'mixed') states.push('mixed');
      if (p.name === 'expanded' && p.value?.value === true) states.push('expanded');
      if (p.name === 'disabled' && p.value?.value === true) states.push('disabled');
    }
    if (states.length) out.states = states;
    if (node.backendDOMNodeId !== undefined) out.backendId = node.backendDOMNodeId;
    return [out];
  }

  const lines: string[] = [];
  const refs: { [k: string]: DetailedRef } = {};
  let counter = 0;

  function emit(node: RenderNode, depth: number): void {
    let prefix = '   '; // 3 spaces when no ref
    if (node.backendId !== undefined) {
      counter++;
      refs[String(counter)] = { backendId: node.backendId, role: node.role, name: node.name };
      prefix = `@${counter}`.padEnd(4, ' ');
    }
    const name = node.name ? ` "${node.name}"` : '';
    const value = node.value !== undefined ? ` value=${node.value}` : '';
    const states = node.states ? ` [${node.states.join(' ')}]` : '';
    // --interactive 는 줄만 거른다 — 번호는 전체 트리와 같게 매겨 `snapshot` 의 @N 과 일치한다
    if (!opts.interactiveOnly || node.interactive) {
      lines.push(`${prefix}${opts.interactiveOnly ? '' : '  '.repeat(depth)}${node.role}${name}${value}${states}`);
    }
    for (const child of node.children) emit(child, depth + 1);
  }

  for (const top of build(root)) emit(top, 0);
  return { lines, refs, folded };
}

