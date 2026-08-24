import { Command } from 'commander';
import {
  clearConfiguredChrome,
  configPath,
  describeSource,
  inspectCandidates,
  readConfig,
  resolveChrome,
  setConfiguredChrome,
} from '../core/chrome-finder.js';
import { formatTable, success, info, error } from '../output/formatter.js';

/**
 * "어느 Chrome 을 쓰나" 를 물어볼 자리.
 *
 * 기동이 실패한 뒤에야 탐색이 뭘 봤는지 알게 되는 것이 #133 의 실제 통증이었다.
 * `tirno chrome` 은 기동하지 않고 그 판정만 보여주고, `set` 은 그 답을 적어둬서
 * 매 `new` 마다 `--executable-path` 를 다시 주지 않게 한다.
 */
export function registerChromeCommands(program: Command): void {
  const chrome = program
    .command('chrome')
    .description('Which Chrome tirno will launch, and where it looked');

  chrome
    .command('show', { isDefault: true })
    .description('Resolved binary + every candidate in search order')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      const rows = inspectCandidates();
      let resolved: { path: string; source: string } | null = null;
      let failure: string | null = null;
      try {
        const r = resolveChrome();
        resolved = { path: r.path, source: describeSource(r.source) };
      } catch (e) {
        failure = (e as Error).message;
      }

      if (opts.json) {
        console.log(JSON.stringify({ resolved, candidates: rows, configPath: configPath() }, null, 2));
        if (!resolved) process.exit(1);
        return;
      }

      if (resolved) {
        success(`${resolved.path}`);
        info(`from ${resolved.source}`);
      }
      console.log('');
      console.log(formatTable(['SOURCE', 'PATH', 'STATUS'], rows.map(r => [r.source, r.path, r.status])));
      if (!resolved) {
        console.log('');
        error(failure ?? 'Chrome not found');
        process.exit(1);
      }
    });

  chrome
    .command('set')
    .description('Remember this binary — later sessions stop needing --executable-path')
    .argument('<path>', 'Path to a Chrome/Chromium executable')
    .action((p: string) => {
      try {
        const saved = setConfiguredChrome(p);
        success(`chrome = ${saved}`);
        info(`saved to ${configPath()} — env ($TIRNO_CHROME) and --executable-path still win over it`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  chrome
    .command('rm')
    .description('Forget the remembered binary; fall back to env and the search list')
    .action(() => {
      const had = readConfig().chromePath;
      if (!clearConfiguredChrome()) {
        info('Nothing was configured.');
        return;
      }
      success(`Forgot ${had}`);
    });
}
