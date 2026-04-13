import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_DIR = path.join(os.homedir(), '.chromux', 'tmp');

function ensureTmpDir(): void {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

export function writeScreenshot(buffer: Buffer, outPath?: string, format = 'png'): string {
  if (outPath) {
    const dir = path.dirname(outPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outPath, buffer);
    return outPath;
  }

  ensureTmpDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `screenshot-${timestamp}.${format}`;
  const filepath = path.join(TMP_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  return filepath;
}
