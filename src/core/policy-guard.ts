/**
 * 명령 진입 전 정책 확인 — main.ts 의 preAction 훅이 부른다 (#214).
 * 세션을 못 찾으면(정책을 볼 세션이 없으면) 아무것도 안 한다 — 그 실패는 명령 자신이 말한다.
 */
import * as store from './session-store.js';
import * as refStore from './ref-store.js';
import { checkPolicy, type Denial } from './policy.js';

const SESSION_FREE = new Set(['new', 'ls', 'schema', 'setup', 'chrome', 'update', 'anchor', 'gc', 'cache', 'recipe', 'stats', 'memory', 'attach', 'rename', 'export', 'kill', 'restart', 'drift', 'broadcast', 'plan', 'apply']);

export function guardPolicy(command: string, argv: string[], opts: { session?: string; confirm?: boolean; allowEval?: boolean }): Denial | null {
  if (SESSION_FREE.has(command)) return null;
  const name = opts.session ?? store.getActive();
  if (!name) return null;
  let meta: store.SessionMetadata;
  try { meta = store.get(name); } catch { return null; }
  if (!meta.policy) return null;
  // 명령 이름 뒤의 인자만 — `tirno click …` 의 `click` 은 뺀다
  const i = argv.indexOf(command);
  const rest = i === -1 ? argv : argv.slice(i + 1);
  const cleaned: string[] = [];
  for (let k = 0; k < rest.length; k++) {
    if (rest[k] === '-s' || rest[k] === '--session') { k++; continue; }
    cleaned.push(rest[k]);
  }
  return checkPolicy(meta.policy, {
    command, argv: cleaned,
    confirmed: !!opts.confirm || cleaned.includes('--confirm'),
    allowEval: !!opts.allowEval || cleaned.includes('--allow-eval'),
    nameOfRef: (ref) => { try { return refStore.resolveStored(name, ref).stored.name; } catch { return undefined; } },
  });
}
