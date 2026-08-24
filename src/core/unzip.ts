import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * 최소 ZIP 추출기.
 *
 * 브라우저 아카이브는 `.zip` 으로만 배포되는데, node 에도 bun 에도 zip 리더가 없다.
 * `unzip` 을 부르는 방법이 있지만, **그것은 이 기능이 없애려는 바로 그 종류의 전제조건**이다
 * (#139: "툴 설치 비용보다 툴의 전제조건 설치 비용이 컸다"). 의존을 하나 더 다는 것도
 * 같은 이유로 안 맞는다 — 이 저장소는 쓰지 않는 740MB 를 덜어낸 전과가 있다.
 *
 * 그래서 필요한 만큼만 직접 읽는다: 중앙 디렉터리 → 엔트리별 로컬 헤더 → deflate.
 * 파일 전체를 메모리에 올리지 않고 fd 에서 필요한 구간만 읽는다(아카이브가 200MB 다).
 */

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  /** 상위 16비트가 unix 모드다 — 실행 비트와 심링크가 여기 산다. */
  externalAttrs: number;
}

function readAt(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, buf, read, length - read, offset + read);
    if (n === 0) break;
    read += n;
  }
  return read === length ? buf : buf.subarray(0, read);
}

function findEocd(fd: number, fileSize: number): { entries: number; centralOffset: number } {
  // EOCD 는 끝에 있고, 주석이 있으면 그만큼 앞으로 밀린다. 주석 최대 64KB.
  const window = Math.min(fileSize, 0x10000 + 22);
  const tail = readAt(fd, fileSize - window, window);
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== EOCD_SIG) continue;
    let entries = tail.readUInt16LE(i + 10);
    let centralOffset = tail.readUInt32LE(i + 16);

    // 0xFFFF/0xFFFFFFFF 는 "zip64 를 보라" 는 뜻이다.
    if (entries === 0xffff || centralOffset === 0xffffffff) {
      const locatorAt = i - 20;
      if (locatorAt >= 0 && tail.readUInt32LE(locatorAt) === EOCD64_LOCATOR_SIG) {
        const eocd64Offset = Number(tail.readBigUInt64LE(locatorAt + 8));
        const eocd64 = readAt(fd, eocd64Offset, 56);
        if (eocd64.readUInt32LE(0) === EOCD64_SIG) {
          entries = Number(eocd64.readBigUInt64LE(32));
          centralOffset = Number(eocd64.readBigUInt64LE(48));
        }
      }
    }
    return { entries, centralOffset };
  }
  throw new Error('Not a zip file (no end-of-central-directory record)');
}

/** zip64 extra field(0x0001)는 32비트로 안 담기는 값만 순서대로 싣는다. */
function applyZip64Extra(extra: Buffer, entry: Entry): void {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    if (id === 0x0001) {
      let q = p + 4;
      if (entry.size === 0xffffffff && q + 8 <= p + 4 + len) { entry.size = Number(extra.readBigUInt64LE(q)); q += 8; }
      if (entry.compressedSize === 0xffffffff && q + 8 <= p + 4 + len) { entry.compressedSize = Number(extra.readBigUInt64LE(q)); q += 8; }
      if (entry.localOffset === 0xffffffff && q + 8 <= p + 4 + len) { entry.localOffset = Number(extra.readBigUInt64LE(q)); }
      return;
    }
    p += 4 + len;
  }
}

function readCentralDirectory(fd: number, fileSize: number): Entry[] {
  const { entries, centralOffset } = findEocd(fd, fileSize);
  const entriesOut: Entry[] = [];
  let offset = centralOffset;
  for (let i = 0; i < entries; i++) {
    const head = readAt(fd, offset, 46);
    if (head.length < 46 || head.readUInt32LE(0) !== CENTRAL_SIG) break;
    const nameLen = head.readUInt16LE(28);
    const extraLen = head.readUInt16LE(30);
    const commentLen = head.readUInt16LE(32);
    const rest = readAt(fd, offset + 46, nameLen + extraLen);
    const entry: Entry = {
      name: rest.subarray(0, nameLen).toString('utf-8'),
      method: head.readUInt16LE(10),
      compressedSize: head.readUInt32LE(20),
      size: head.readUInt32LE(24),
      localOffset: head.readUInt32LE(42),
      externalAttrs: head.readUInt32LE(38),
    };
    applyZip64Extra(rest.subarray(nameLen), entry);
    entriesOut.push(entry);
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entriesOut;
}

/**
 * 아카이브 밖으로 나가는 경로를 거부한다. `../` 도, 절대경로도, 드라이브 문자도.
 * 남이 만든 zip 을 푸는 코드에서 이것이 없으면 그것은 임의 파일 쓰기다.
 */
export function safeJoin(dest: string, name: string): string | null {
  const normalized = path.normalize(name).replace(/^([/\\]|[a-zA-Z]:)+/, '');
  if (!normalized || normalized === '.') return null;
  const full = path.resolve(dest, normalized);
  const root = path.resolve(dest) + path.sep;
  return full.startsWith(root) ? full : null;
}

export interface UnzipResult {
  files: number;
  symlinks: number;
  skipped: string[];
}

export function unzip(archive: string, dest: string): UnzipResult {
  const fd = fs.openSync(archive, 'r');
  const result: UnzipResult = { files: 0, symlinks: 0, skipped: [] };
  try {
    const fileSize = fs.fstatSync(fd).size;
    for (const entry of readCentralDirectory(fd, fileSize)) {
      const target = safeJoin(dest, entry.name);
      if (!target) {
        result.skipped.push(entry.name);
        continue;
      }
      if (entry.name.endsWith('/')) {
        fs.mkdirSync(target, { recursive: true });
        continue;
      }

      // 로컬 헤더의 이름·extra 길이는 중앙 디렉터리와 다를 수 있다. 데이터 시작은
      // 반드시 로컬 헤더에서 다시 계산한다.
      const local = readAt(fd, entry.localOffset, 30);
      const dataStart = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const raw = readAt(fd, dataStart, entry.compressedSize);
      const content = entry.method === 0 ? raw : zlib.inflateRawSync(raw);

      fs.mkdirSync(path.dirname(target), { recursive: true });
      const unixMode = (entry.externalAttrs >>> 16) & 0xffff;
      if ((unixMode & 0xf000) === 0xa000) {
        // 심링크. 내용이 링크 대상이다 — 파일로 쓰면 앱 번들이 조용히 깨진다.
        const linkTarget = content.toString('utf-8');
        try { fs.unlinkSync(target); } catch { /* 없으면 그만 */ }
        fs.symlinkSync(linkTarget, target);
        result.symlinks++;
        continue;
      }
      fs.writeFileSync(target, content);
      // 실행 비트가 살아 있어야 한다. 이것을 잃으면 받아온 chrome 이 안 돈다.
      if (unixMode) fs.chmodSync(target, unixMode & 0o7777);
      result.files++;
    }
  } finally {
    fs.closeSync(fd);
  }
  return result;
}
