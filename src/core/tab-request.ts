import type { Command } from 'commander';

/**
 * 이 명령이 `--tab <id>` 로 고른 탭. 장부의 선택(`select`)보다 우선하고 저장하지 않는다 —
 * 한 세션을 여러 작업자가 탭 하나씩 나눠 쓸 때, 서로의 선택을 덮어쓰지 않게 하려는 것이다.
 */
let requested: string | undefined;

export function setRequestedTab(id: string | undefined): void {
  requested = id?.trim().toLowerCase() || undefined;
}

export function requestedTab(): string | undefined {
  return requested;
}

/** 탭 ID — 엔진이 주는 식별자(Chrome targetId · Firefox UUID · Safari `page-…`)의 앞 8자 */
export function tabHandle(id: string): string {
  return id.replace(/^page-/i, '').replace(/-/g, '').slice(0, 8).toLowerCase();
}

const TAB_FREE = new Set(['pages', 'new-tab', 'select', 'close-tab']);

/** 세션을 받는 명령에 `--tab` 을 붙인다. 탭 자체를 다루는 명령은 이미 ID 를 인자로 받는다 */
export function addTabOption(program: Command): void {
  const walk = (c: Command): void => {
    if (c.options.some(o => o.long === '--session') && !TAB_FREE.has(c.name())) {
      c.option('--tab <id>', 'Act on this tab (id from `tirno pages`, 4+ characters) for this command only — does not change the selected tab');
    }
    c.commands.forEach(walk);
  };
  program.commands.forEach(walk);
}
