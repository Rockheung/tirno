#!/usr/bin/env node
/**
 * `assets/icon/tirno.svg` → `src/core/icon-data.ts` (base64 .icns).
 *
 * **왜 산출물을 커밋하나.** 릴리즈 바이너리는 `bun build dist/main.js --compile` 이
 * 묶는다 — dist 바깥의 파일은 따라 들어가지 않는다. 그래서 아이콘은 소스 안의 상수여야
 * 하고, 이 스크립트는 그 상수를 **macOS 에서만** 다시 만든다 (sips·iconutil 은 macOS 의
 * 것이다). 아이콘을 고치는 사람만 돌리면 되고, 빌드와 CI 는 커밋된 결과를 쓴다.
 *
 *   node scripts/make-icon.mjs
 *
 * 1024 는 일부러 뺀다. 독·앱스위처·Finder 가 쓰는 최대가 512 이고, 1024 한 장이 파일의
 * 절반을 차지한다 (629KB → 286KB).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = path.join(repo, 'assets/icon/tirno.svg');
const out = path.join(repo, 'src/core/icon-data.ts');

/** 아이콘 사다리. `iconutil` 이 요구하는 이름이고, 이름이 곧 크기다. */
const LADDER = [
  [16, 'icon_16x16'], [32, 'icon_16x16@2x'],
  [32, 'icon_32x32'], [64, 'icon_32x32@2x'],
  [128, 'icon_128x128'], [256, 'icon_128x128@2x'],
  [256, 'icon_256x256'], [512, 'icon_256x256@2x'],
  [512, 'icon_512x512'],
];

function findChrome() {
  const named = process.env['TIRNO_CHROME'] ?? process.env['CHROME_PATH'];
  const candidates = [
    named,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    `${os.homedir()}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('No Chrome to render the SVG with. Point TIRNO_CHROME at one.');
}

if (process.platform !== 'darwin') {
  console.error('macOS only — sips and iconutil make the .icns. The committed icon-data.ts is what builds use.');
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-icon-'));
try {
  const png = path.join(tmp, 'icon-1024.png');
  // --default-background-color=00000000 이 없으면 모서리가 흰색으로 차서, 둥근 판이
  // 사각형 안에 박힌 아이콘이 된다.
  execFileSync(findChrome(), [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1', '--default-background-color=00000000',
    '--window-size=1024,1024', `--screenshot=${png}`, `file://${svg}`,
  ], { stdio: 'pipe' });
  if (!fs.existsSync(png)) throw new Error('Chrome wrote no screenshot');

  const iconset = path.join(tmp, 'tirno.iconset');
  fs.mkdirSync(iconset);
  for (const [size, name] of LADDER) {
    execFileSync('sips', ['-z', String(size), String(size), png, '--out', path.join(iconset, `${name}.png`)], { stdio: 'pipe' });
  }

  const icns = path.join(tmp, 'tirno.icns');
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icns], { stdio: 'pipe' });

  const bytes = fs.readFileSync(icns);
  if (bytes.subarray(0, 4).toString('ascii') !== 'icns') throw new Error('iconutil produced something that is not an .icns');

  const b64 = bytes.toString('base64');
  fs.writeFileSync(out, [
    '// 생성된 파일이다. 손으로 고치지 말고 `node scripts/make-icon.mjs` 를 돌린다.',
    '// 원본은 assets/icon/tirno.svg 이고, 이것은 그것을 구운 .icns 다 (16~512px).',
    `// ${bytes.length} bytes, ${LADDER.length} sizes.`,
    '',
    `export const ICNS_BASE64 = '${b64}';`,
    '',
  ].join('\n'));
  console.log(`${out}  ←  ${bytes.length} bytes icns, ${b64.length} base64 chars`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
