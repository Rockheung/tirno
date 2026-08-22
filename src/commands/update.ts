import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { success, info, warn, error } from '../output/formatter.js';
import {
  REPO, assetNameFor, compareVersions, installedPluginsPath, parseChecksums,
  pluginVersionFrom, replaceBinary, selfReplaceTarget, sha256, type Release,
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
function installedPluginVersion(): string | null {
  try {
    return pluginVersionFrom(fs.readFileSync(
      installedPluginsPath(os.homedir(), process.env.CLAUDE_CONFIG_DIR), 'utf-8'));
  } catch {
    return null;                     // 설치된 적이 없거나 읽을 수 없다
  }
}

function updateSkills(): 'updated' | 'no-claude' {
  try {
    execFileSync('claude', ['plugin', 'marketplace', 'update', 'tirno'], { stdio: 'pipe' });
    // 마켓플레이스를 밝힌다. 같은 이름의 플러그인이 다른 마켓플레이스에도 있으면
    // 이름만으로는 어느 것인지 정해지지 않는다.
    execFileSync('claude', ['plugin', 'update', 'tirno@tirno'], { stdio: 'pipe' });
    return 'updated';
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return 'no-claude';
    // 마켓플레이스를 한 번도 추가하지 않았으면 여기서 걸린다. 그 경우 고칠 것은
    // tirno 가 아니라 등록이므로, 무엇을 하라는지까지 말한다.
    throw new Error(
      `claude plugin update failed: ${(e as Error).message}\n` +
      'If the marketplace is missing: claude plugin marketplace add Rockheung/tirno',
      { cause: e });
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

        // 바이너리와 플러그인은 따로 낡는다. 하나로 판정하면 다른 하나가 낡은 채
        // "최신입니다" 가 나가고, 두 갈래를 묶는 것이 이 명령의 존재 이유다.
        const plugin = installedPluginVersion();
        const binaryBehind = compareVersions(current, latest) < 0;
        const pluginBehind = plugin !== null && compareVersions(plugin, latest) < 0;

        const state = (v: string | null) =>
          v === null ? 'not installed'
            : compareVersions(v, latest) < 0 ? 'behind'
              : compareVersions(v, latest) > 0 ? 'ahead' : 'up to date';
        console.log(`binary  ${current.padEnd(8)} · latest ${latest} · ${state(current)}`);
        console.log(`plugin  ${(plugin ?? '-').padEnd(8)} · latest ${latest} · ${state(plugin)}`);

        if (opts.check) {
          if (binaryBehind || pluginBehind) info('Run "tirno update" to move both to ' + latest + '.');
          else info('Nothing to do.');
          return;
        }

        if (!binaryBehind && !pluginBehind) {
          info('Nothing to do.');
          return;
        }

        if (!opts.skillsOnly && binaryBehind) {
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

        if (!opts.binaryOnly && pluginBehind) {
          const skills = updateSkills();
          if (skills === 'no-claude') {
            warn('`claude` not on PATH — skills unchanged. Update them with `claude plugin marketplace update tirno && claude plugin update tirno`.');
          } else {
            success(`Skills ${plugin} → ${latest} (restart Claude Code to apply)`);
          }
        } else if (!opts.binaryOnly && plugin === null) {
          info('Skill plugin is not installed — `claude plugin marketplace add Rockheung/tirno && claude plugin install tirno@tirno`.');
        }
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}
