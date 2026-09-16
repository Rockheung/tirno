/**
 * `tirno plugin` — 번들에 없는 것을 붙인다 (#216). 지금은 audit(lighthouse) 하나.
 */
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { success, info, fail, formatTable } from '../output/formatter.js';
import { locateLighthouse, installLighthouse, pluginRoot, INSTALL_HINT } from '../core/plugin-lighthouse.js';

const PLUGINS: Record<string, { what: string; install: () => { dir: string; output: string }; locate: () => { entry: string; source: string } | null }> = {
  audit: { what: 'lighthouse for `tirno audit`', install: () => installLighthouse(), locate: () => locateLighthouse() },
};

export function registerPluginCommands(program: Command): void {
  const plugin = program.command('plugin').description('Optional pieces that are not in the binary. `audit` = lighthouse');

  plugin
    .command('ls')
    .description('What is installed and where it was found')
    .action(() => {
      console.log(formatTable(['PLUGIN', 'WHAT', 'STATUS'], Object.entries(PLUGINS).map(([name, p]) => {
        const l = p.locate();
        return [name, p.what, l ? `found (${l.source}): ${l.entry}` : 'not installed — `tirno plugin install ' + name + '`'];
      })));
    });

  plugin
    .command('install')
    .description('Install a plugin under ~/.tirno/plugins/<name> with npm')
    .argument('<name>', Object.keys(PLUGINS).join(' | '))
    .action((name: string) => {
      try {
        const p = PLUGINS[name];
        if (!p) throw new Error(`unknown plugin "${name}" — ${Object.keys(PLUGINS).join(' | ')}`);
        const before = p.locate();
        if (before) info(`${name}: already found (${before.source}) — reinstalling into ${pluginRoot()}`);
        info(`npm install lighthouse → ${pluginRoot()} …`);
        const { dir } = p.install();
        const after = p.locate();
        if (!after) throw new Error(`installed into ${dir} but could not locate the entry afterwards\n${INSTALL_HINT}`);
        success(`${name}: ${after.entry}`);
      } catch (e) {
        fail(e);
      }
    });

  plugin
    .command('rm')
    .description('Remove an installed plugin directory')
    .argument('<name>', Object.keys(PLUGINS).join(' | '))
    .action((name: string) => {
      try {
        if (!PLUGINS[name]) throw new Error(`unknown plugin "${name}"`);
        const dir = pluginRoot();
        if (!fs.existsSync(path.join(dir, 'node_modules'))) { info(`${name}: nothing installed at ${dir}`); return; }
        fs.rmSync(dir, { recursive: true, force: true });
        success(`removed ${dir}`);
      } catch (e) {
        fail(e);
      }
    });
}
