import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseProcNetTcp, cmdlineFromProc, scanProcListeners } from '../src/core/proc-net.js';

// /proc 백엔드 — lsof 가 없는 이미지에서도 소유권을 판정한다 (#186). 아래 본문은 실제
// Ubuntu 24.04 (oci-ko, lsof 미설치) 에서 캡처한 것이고, 그 호스트에서 scanProcListeners 가
// `ss -ltnp` 와 같은 두 프로세스(pid 875 :8317, pid 2214 :6767)를 냈다 (2026-09-16).

const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0CEA 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 24356 1 0000000000000000 100 0 0 10 0
   1: 04004D0A:207D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 31337 1 0000000000000000 100 0 0 10 0
   2: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 20001 1 0000000000000000 100 0 0 10 0
   3: 0100007F:E4A8 0100007F:0CEA 01 00000000:00000000 00:00000000 00000000  1000        0 40000 1 0000000000000000 20 4 30 10 -1
`;
const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:2382 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 51515 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 20002 1 0000000000000000 100 0 0 10 0
`;

test('LISTEN(0A) 만 남기고 주소·포트를 사람 표기로 푼다', () => {
  const v4 = parseProcNetTcp(TCP, 'IPv4');
  assert.deepEqual(v4.map(s => [s.address, s.port, s.inode]), [
    ['127.0.0.1', 3306, '24356'],
    ['10.77.0.4', 8317, '31337'],
    ['*', 22, '20001'],
  ], 'ESTABLISHED(01) 행은 빠져야 한다');
  const v6 = parseProcNetTcp(TCP6, 'IPv6');
  assert.deepEqual(v6.map(s => [s.address, s.port]), [['[::1]', 9090], ['*', 22]]);
});

test('/proc/<pid>/cmdline 의 NUL 을 한 줄로 편다 — 값 속 공백은 보존', () => {
  assert.equal(cmdlineFromProc('/opt/chrome\0--user-data-dir=/home/me/my profiles/a\0--headless\0\0'),
    '/opt/chrome --user-data-dir=/home/me/my profiles/a --headless');
  assert.equal(cmdlineFromProc(''), null);
});

test('가짜 /proc 트리에서 inode → pid 를 잇고, 못 읽는 pid 는 건너뛴다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-proc-'));
  try {
    fs.mkdirSync(path.join(root, 'net'));
    fs.writeFileSync(path.join(root, 'net', 'tcp'), TCP);
    fs.writeFileSync(path.join(root, 'net', 'tcp6'), TCP6);
    // pid 875 가 inode 31337 과 51515 를 들고 있다
    fs.mkdirSync(path.join(root, '875', 'fd'), { recursive: true });
    fs.symlinkSync('socket:[31337]', path.join(root, '875', 'fd', '8'));
    fs.symlinkSync('socket:[51515]', path.join(root, '875', 'fd', '9'));
    fs.symlinkSync('/dev/null', path.join(root, '875', 'fd', '0'));
    fs.writeFileSync(path.join(root, '875', 'comm'), 'cli-proxy-api\n');
    // pid 1 은 fd 디렉터리가 없다(남의 것) — 건너뛴다
    fs.mkdirSync(path.join(root, '1'));
    // 숫자가 아닌 항목은 pid 가 아니다
    fs.mkdirSync(path.join(root, 'self'));

    const l = scanProcListeners(root);
    assert.deepEqual(l.map(x => [x.pid, x.command, x.family, x.address, x.port]), [
      [875, 'cli-proxy-api', 'IPv4', '10.77.0.4', 8317],
      [875, 'cli-proxy-api', 'IPv6', '[::1]', 9090],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('/proc/net/tcp 가 없으면 던진다 — 빈 목록으로 접지 않는다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-proc-'));
  try {
    assert.throws(() => scanProcListeners(root), /ENOENT/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
