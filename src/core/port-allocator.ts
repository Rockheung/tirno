import net from 'node:net';
import * as store from './session-store.js';
import { PortUnavailable } from '../util/errors.js';

const PORT_MIN = 9222;
const PORT_MAX = 9322;

function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

export async function allocate(preferred?: number): Promise<number> {
  if (preferred !== undefined) {
    if (await isPortFree(preferred)) return preferred;
    throw new PortUnavailable(preferred);
  }

  const usedPorts = new Set(store.list().map(s => s.port));

  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    if (usedPorts.has(port)) continue;
    if (await isPortFree(port)) return port;
  }

  throw new PortUnavailable(0);
}
