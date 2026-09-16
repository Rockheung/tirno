/**
 * linux 의 `/proc` 에서 TCP 리스너를 읽는다 — 외부 바이너리 없이 (#186).
 *
 * `lsof` 가 없으면 리스너 목록이 `[]` 로 접혔고, 그러면 살아 있는 세션이 `foreign`
 * ("nothing listens") 이나 `ghost` 로 읽혔다. 관측 도구의 부재가 프로세스의 부재와 같은
 * 답을 냈다. 최소 컨테이너 이미지(`debian:slim` · distroless)와 일부 CI 러너가 그 자리다.
 *
 * `/proc/net/tcp{,6}` 는 LISTEN 소켓의 inode 를 주고, `/proc/<pid>/fd/*` 는 어느 pid 가
 * 그 inode 를 들고 있는지 준다. 자기 uid 의 프로세스만 읽히는 것은 lsof 와 같다.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Listener } from './inventory.js';

export interface ProcSocket {
  inode: string;
  port: number;
  address: string;
  family: 'IPv4' | 'IPv6';
}

const LISTEN = '0A';

/** `0100007F` → `127.0.0.1` (리틀엔디언 4바이트) */
function ipv4(hex: string): string {
  if (/^0+$/.test(hex)) return '*';
  const b = hex.match(/../g)!.map(h => Number.parseInt(h, 16));
  return `${b[3]}.${b[2]}.${b[1]}.${b[0]}`;
}

/** 32자리 hex(4바이트 리틀엔디언 워드 4개) → `[::1]` 꼴. 표시용이라 압축은 간단히. */
function ipv6(hex: string): string {
  if (/^0+$/.test(hex)) return '*';
  const words: string[] = [];
  for (let i = 0; i < 32; i += 8) {
    const w = hex.slice(i, i + 8).match(/../g)!.reverse().join('');
    words.push(w.slice(0, 4).replace(/^0+(?=.)/, ''), w.slice(4).replace(/^0+(?=.)/, ''));
  }
  const joined = words.join(':');
  return `[${joined === '0:0:0:0:0:0:0:1' ? '::1' : joined}]`;
}

/**
 * `/proc/net/tcp` 본문을 파싱한다. 헤더 한 줄 뒤로
 * `sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode …`.
 * LISTEN(`0A`) 만 남긴다.
 */
export function parseProcNetTcp(text: string, family: 'IPv4' | 'IPv6'): ProcSocket[] {
  const out: ProcSocket[] = [];
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10 || cols[3] !== LISTEN) continue;
    const [addrHex, portHex] = cols[1].split(':');
    if (!addrHex || !portHex) continue;
    const port = Number.parseInt(portHex, 16);
    if (Number.isNaN(port) || port <= 0) continue;
    out.push({
      inode: cols[9], port, family,
      address: family === 'IPv4' ? ipv4(addrHex) : ipv6(addrHex),
    });
  }
  return out;
}

/** `/proc/<pid>/cmdline` 은 NUL 구분이다 — `ps -o command=` 와 같은 한 줄로 편다. */
export function cmdlineFromProc(buf: string): string | null {
  const s = buf.replace(/\0+$/, '').split('\0').join(' ').trim();
  return s || null;
}

function readComm(pid: number, root: string): string {
  try {
    return fs.readFileSync(path.join(root, String(pid), 'comm'), 'utf8').trim();
  } catch {
    return '?';
  }
}

/**
 * 실제 스캔. `root` 는 테스트용(가짜 /proc 트리). 읽을 수 없는 pid 는 건너뛴다 —
 * 남의 프로세스의 fd 는 원래 안 보이고, 그것은 lsof 도 마찬가지다.
 */
export function scanProcListeners(root = '/proc'): Listener[] {
  // tcp 가 없으면 관측 실패다 — 던져서 unknown 이 되게 한다. 빈 배열로 접으면 그것이
  // 바로 이 파일이 없애려는 오판이다. tcp6 만은 IPv6 가 꺼진 커널에 없으므로 봐준다.
  const sockets = parseProcNetTcp(fs.readFileSync(path.join(root, 'net', 'tcp'), 'utf8'), 'IPv4');
  try {
    sockets.push(...parseProcNetTcp(fs.readFileSync(path.join(root, 'net', 'tcp6'), 'utf8'), 'IPv6'));
  } catch {
    // no IPv6
  }
  if (sockets.length === 0) return [];
  const byInode = new Map(sockets.map(s => [s.inode, s]));

  const listeners: Listener[] = [];
  for (const entry of fs.readdirSync(root)) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let fds: string[];
    try {
      fds = fs.readdirSync(path.join(root, entry, 'fd'));
    } catch {
      continue;
    }
    let command: string | null = null;
    for (const fd of fds) {
      let link: string;
      try {
        link = fs.readlinkSync(path.join(root, entry, 'fd', fd));
      } catch {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      const sock = m && byInode.get(m[1]);
      if (!sock) continue;
      command ??= readComm(pid, root);
      listeners.push({ pid, command, family: sock.family, address: sock.address, port: sock.port });
    }
  }
  return listeners;
}
