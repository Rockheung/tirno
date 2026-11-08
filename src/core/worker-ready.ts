import fs from 'node:fs';

/**
 * 분리 워커가 캡처를 시작했다고 표지를 남길 때까지 기다린다. `start` 가 이것 없이 돌아오면
 * 바로 이어지는 동작이 캡처 시작보다 먼저 끝나 아무것도 안 잡힌다. 워커가 먼저 죽으면
 * 로그의 마지막 줄로 실패한다.
 */
export async function waitForWorker(pid: number, marker: string, log: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(marker)) return;
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (!alive) {
      const last = (() => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').at(-1); } catch { return undefined; } })();
      throw new Error(`worker ${pid} exited before it started${last ? ` — ${last}` : ''}`);
    }
    if (Date.now() >= deadline) throw new Error(`worker ${pid} has not started after ${timeoutMs}ms — see ${log}`);
    await new Promise(r => setTimeout(r, 100));
  }
}
