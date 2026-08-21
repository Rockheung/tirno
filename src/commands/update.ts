import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { success, info, warn, error } from '../output/formatter.js';
import {
  REPO, assetNameFor, compareVersions, parseChecksums, replaceBinary,
  selfReplaceTarget, sha256, type Release,
} from '../core/update.js';

async function latestRelease(): Promise<Release> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'tirno-update' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} — could not read the latest release`);
  return await res.json() as Release;
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'user-agent': 'tirno-update' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 스킬은 Claude Code 가 자기 상태로 관리한다. 파일을 직접 만지면 그 상태와 어긋나므로
 * `claude plugin` 을 부른다. 마켓플레이스를 먼저 당기지 않으면 플러그인 갱신이 옛
 * 매니페스트를 보고 "최신" 이라고 답한다.
 */
function updateSkills(): 'updated' | 'no-claude' {
  try {
    execFileSync('claude', ['plugin', 'marketplace', 'update', 'tirno'], { stdio: 'pipe' });
    execFileSync('claude', ['plugin', 'update', 'tirno'], { stdio: 'pipe' });
    return 'updated';
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return 'no-claude';
    throw new Error(`claude plugin update failed: ${(e as Error).message}`, { cause: e });
  }
}

export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .description('Update to the latest release — replaces the running binary in place, and refreshes the skill plugin via `claude plugin`')
    .option('--check', 'Only report what is available; change nothing')
    .option('--skills-only', 'Skip the binary, refresh only the skill plugin')
    .option('--binary-only', 'Skip the skill plugin, replace only the binary')
    .action(async (opts) => {
      try {
        const current = program.version() ?? '0.0.0';
        const release = await latestRelease();
        const latest = release.tag_name.replace(/^v/, '');
        const behind = compareVersions(current, latest) < 0;

        console.log(`current ${current} · latest ${latest}`);

        if (!behind) {
          // 앞서 있는 경우도 있다 — 소스에서 돌리는 중이면 태그보다 앞선다.
          info(compareVersions(current, latest) > 0
            ? 'Running ahead of the latest release — nothing to do.'
            : 'Already up to date.');
          if (!opts.check) return;
        }
        if (opts.check) {
          if (behind) info(`Run "tirno update" to move to ${latest}.`);
          return;
        }

        if (!opts.skillsOnly) {
          const target = selfReplaceTarget(process.execPath, process.versions.bun);
          if (!target) {
            warn('Not a packaged binary — skipping the binary. Source checkouts update with `git pull && npm run build`.');
          } else {
            const name = assetNameFor(process.platform, process.arch);
            const asset = release.assets.find(a => a.name === name);
            const sums = release.assets.find(a => a.name === 'SHA256SUMS');
            if (!asset) throw new Error(`Release ${latest} has no ${name}`);
            if (!sums) throw new Error(`Release ${latest} has no SHA256SUMS — refusing to install unverified`);

            const [bin, sumsText] = await Promise.all([
              download(asset.browser_download_url),
              download(sums.browser_download_url).then(b => b.toString('utf-8')),
            ]);

            // 체크섬이 없으면 설치하지 않는다. 받은 것이 릴리즈가 낸 것인지
            // 확인할 방법이 사라지고, 그 자리에서 실행되는 파일이다.
            const expected = parseChecksums(sumsText).get(name);
            if (!expected) throw new Error(`SHA256SUMS has no entry for ${name}`);
            const actual = sha256(bin);
            if (actual !== expected) {
              throw new Error(`Checksum mismatch for ${name}\n  expected ${expected}\n  got      ${actual}`);
            }

            replaceBinary(target, bin);
            success(`Binary ${current} → ${latest} (${target})`);
          }
        }

        if (!opts.binaryOnly) {
          const skills = updateSkills();
          if (skills === 'no-claude') {
            warn('`claude` not on PATH — skills unchanged. Update them with `claude plugin marketplace update tirno && claude plugin update tirno`.');
          } else {
            success('Skills refreshed (restart Claude Code to apply)');
          }
        }
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}
