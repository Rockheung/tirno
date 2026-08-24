import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * 필요한 필드만 채운 최소 zip 라이터. **테스트 픽스처 전용**이다.
 *
 * 리더(`core/unzip.ts`)를 직접 들고 있으므로 그것을 검증할 zip 도 직접 만들어야 한다.
 * 의존을 하나 더 다는 것은 이 저장소의 방향과 반대다.
 */
export interface Member {
  name: string;
  data: Buffer;
  /** unix 모드. 심링크는 0o120000 을 켠다. */
  mode: number;
  deflate?: boolean;
}

const crc32 = (b: Buffer): number =>
  typeof (zlib as { crc32?: (b: Buffer) => number }).crc32 === 'function'
    ? (zlib as unknown as { crc32: (b: Buffer) => number }).crc32(b) >>> 0
    : 0;

/** 필요한 필드만 채운 최소 zip 라이터. 테스트 픽스처 전용이다. */
export function makeZip(dir: string, members: Member[]): string {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const m of members) {
    const stored = m.deflate ? zlib.deflateRawSync(m.data) : m.data;
    const nameBuf = Buffer.from(m.name, 'utf-8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(m.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(m.data), 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(m.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, stored);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(3 << 8 | 20, 4); // 상위 바이트 3 = unix
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(m.deflate ? 8 : 0, 10);
    cd.writeUInt32LE(crc32(m.data), 16);
    cd.writeUInt32LE(stored.length, 20);
    cd.writeUInt32LE(m.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(((m.mode & 0xffff) << 16) >>> 0, 38); // << 16 은 int32 를 넘겨 음수가 된다
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + stored.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  const file = path.join(dir, 'test.zip');
  fs.writeFileSync(file, Buffer.concat([...chunks, centralBuf, eocd]));
  return file;
}


export const member = (name: string, body: string, mode = 0o100644, deflate = false): Member =>
  ({ name, data: Buffer.from(body), mode, deflate });
