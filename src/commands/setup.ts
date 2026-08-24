import { Command } from 'commander';
import { describeSource, inspectCandidates, resolveChrome } from '../core/chrome-finder.js';
import {
  apparmorProfile, chromeRoot, humanBytes, install, listInstalled,
  plan, platformKey, remember, usernsRestricted,
} from '../core/provision.js';
import { formatTable, success, info, warn, error } from '../output/formatter.js';

/**
 * `tirno setup` — 있으면 그렇다고 말하고, 없으면 받아온다.
 *
 * #133 은 "탐색 경로가 부족하다" 는 버그였고 이것은 그 위의 설계다: **찾는 대신 깔아준다.**
 * 자동 탐색이 실패했을 때 사용자가 시스템 경로에 손대는 쪽으로 몰리는 것이 문제였다.
 */
export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Make sure a browser is available — report what is there, or fetch one into ~/.tirno')
    .option('--check', 'Diagnose only: where tirno looked, what it found, why it failed')
    .option('-y, --yes', 'Do not ask before downloading')
    .option('--force', 'Fetch even if a browser is already resolved')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        let resolved: { path: string; source: string } | null = null;
        try {
          const r = resolveChrome();
          resolved = { path: r.path, source: describeSource(r.source) };
        } catch { /* 없다는 것이 이 명령의 출발점이다 */ }

        if (opts.check) {
          reportCheck(resolved, opts.json);
          if (!resolved) process.exit(1);
          return;
        }

        if (resolved && !opts.force) {
          if (opts.json) {
            console.log(JSON.stringify({ action: 'none', resolved }, null, 2));
            return;
          }
          success(`${resolved.path}`);
          info(`from ${resolved.source} — nothing to do. --force fetches a fresh copy anyway.`);
          sandboxNote(resolved.path);
          return;
        }

        const key = platformKey();
        if (!key) {
          throw new Error(
            `No browser build for ${process.platform}-${process.arch}. ` +
            `Install one yourself and point tirno at it: tirno chrome set <path>`
          );
        }

        const p = await plan(key);
        if (!opts.json) {
          info(`${p.source} · chrome ${p.version} · ${key}`);
          info(`  ${p.url}`);
          info(`  → ${chromeRoot()}/${p.label}   (no sudo, nothing outside ~/.tirno)`);
        }

        // 200MB 를 묻지도 않고 받지 않는다. 다만 TTY 가 아니면(스크립트·CI) 물어봐야
        // 할 사람이 없으므로, 그 자리에서 멈추는 대신 --yes 를 요구한다.
        if (!opts.yes) {
          if (process.stdin.isTTY !== true) {
            throw new Error('Refusing to download ~200MB without confirmation. Pass --yes (or run it in a terminal).');
          }
          const ok = await confirm(`Download it now?`);
          if (!ok) {
            info('Nothing was downloaded.');
            return;
          }
        }

        let lastShown = 0;
        const result = await install(p, {
          onProgress: (received, total) => {
            if (opts.json || process.stdout.isTTY !== true) return;
            const now = Date.now();
            if (now - lastShown < 250 && received !== total) return;
            lastShown = now;
            const pct = total ? ` ${Math.round((received / total) * 100)}%` : '';
            process.stdout.write(`\r  ${humanBytes(received)}${total ? ` / ${humanBytes(total)}` : ''}${pct}   `);
          },
        });
        if (!opts.json && process.stdout.isTTY === true) process.stdout.write('\n');

        remember(result.binary);

        if (opts.json) {
          console.log(JSON.stringify({ action: 'installed', ...result, version: p.version, source: p.source }, null, 2));
          return;
        }
        success(`${result.binary}`);
        info(`${result.files} files, ${humanBytes(result.bytes)} downloaded — saved as the configured chrome`);
        info(`Sessions will use it now: tirno new demo https://example.com --headless`);
        sandboxNote(result.binary);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}

/**
 * 진단만. `chrome` 과 같은 표를 쓰되, **왜 실패했는지와 다음 한 걸음**까지 낸다 —
 * 무엇을 봤는지 안 알려주는 "Chrome not found" 가 #133 의 절반이었다.
 */
function reportCheck(resolved: { path: string; source: string } | null, json: boolean): void {
  const rows = inspectCandidates();
  const installed = listInstalled();
  const key = platformKey();

  if (json) {
    console.log(JSON.stringify({
      resolved, candidates: rows, installed, platform: `${process.platform}-${process.arch}`,
      supported: key !== null, usernsRestricted: usernsRestricted(),
    }, null, 2));
    return;
  }

  console.log(`Platform: ${process.platform}-${process.arch}${key ? '' : '  (no browser build — install one yourself)'}`);
  if (resolved) {
    success(resolved.path);
    info(`from ${resolved.source}`);
  } else {
    warn('No browser resolved.');
  }
  console.log('');
  console.log(formatTable(['SOURCE', 'PATH', 'STATUS'], rows.map(r => [r.source, r.path, r.status])));

  if (installed.length) {
    console.log('');
    console.log(formatTable(['FETCHED BY TIRNO', 'BINARY'], installed.map(i => [i.label, i.binary ?? '(incomplete)'])));
  }
  if (!resolved) {
    console.log('');
    info('Fetch one into ~/.tirno (no sudo): tirno setup');
  }
  if (resolved) sandboxNote(resolved.path);
}

/**
 * 곁다리지만 같은 자리의 통증이다 (#134). 받아온 바이너리 경로를 아는 것은 tirno 뿐이라,
 * 스니펫을 그 경로로 채워서 낼 수 있는 것도 tirno 뿐이다.
 */
function sandboxNote(binary: string): void {
  if (!usernsRestricted()) return;
  console.log('');
  warn('This kernel restricts unprivileged user namespaces, so chromium cannot start its own sandbox.');
  info('Quick way past it:  tirno new demo <url> --headless -- --no-sandbox');
  info('Keeping the sandbox on, for this binary only:');
  for (const line of apparmorProfile(binary).split('\n')) console.log(`    ${line}`);
  info('  sudo apparmor_parser -r /etc/apparmor.d/tirno-chromium');
}

function confirm(question: string): Promise<boolean> {
  return new Promise(resolve => {
    process.stdout.write(`${question} [y/N] `);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    process.stdin.once('data', (d: string) => {
      process.stdin.pause();
      resolve(/^y(es)?$/i.test(d.trim()));
    });
  });
}
