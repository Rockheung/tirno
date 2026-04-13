export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killProcess(pid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export async function killAndWait(pid: number, timeoutMs = 5000): Promise<void> {
  if (!isAlive(pid)) return;

  killProcess(pid, 'SIGTERM');

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return;
    await new Promise(r => setTimeout(r, 200));
  }

  if (isAlive(pid)) {
    killProcess(pid, 'SIGKILL');
  }
}
