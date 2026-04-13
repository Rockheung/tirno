import { Command } from 'commander';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { success, error } from '../output/formatter.js';
import { KnownDevices } from 'puppeteer-core';

const NETWORK_PRESETS: Record<string, { download: number; upload: number; latency: number }> = {
  'slow-3g': { download: 500 * 1024 / 8, upload: 500 * 1024 / 8, latency: 400 },
  'fast-3g': { download: 1.6 * 1024 * 1024 / 8, upload: 750 * 1024 / 8, latency: 150 },
  '4g': { download: 4 * 1024 * 1024 / 8, upload: 3 * 1024 * 1024 / 8, latency: 20 },
  'offline': { download: 0, upload: 0, latency: 0 },
};

export function registerEmulateCommand(program: Command): void {
  program
    .command('emulate')
    .description('Emulate device, network, or CPU')
    .option('-s, --session <name>', 'Session name')
    .option('--device <name>', 'Device preset (e.g. "iPhone 14")')
    .option('--network <profile>', 'Network preset (slow-3g|fast-3g|4g|offline)')
    .option('--cpu <rate>', 'CPU throttle rate (e.g. 4 = 4x slowdown)', parseFloat)
    .option('--list-devices', 'List available device presets')
    .action(async (opts) => {
      if (opts.listDevices) {
        const names = Object.keys(KnownDevices);
        names.forEach(n => console.log(n));
        return;
      }

      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);
        const applied: string[] = [];

        if (opts.device) {
          const device = KnownDevices[opts.device as keyof typeof KnownDevices];
          if (!device) throw new Error(`Unknown device: ${opts.device}. Use --list-devices`);
          await page.emulate(device);
          applied.push(`device=${opts.device}`);
        }

        if (opts.network) {
          const preset = NETWORK_PRESETS[opts.network.toLowerCase()];
          if (!preset) throw new Error(`Unknown network: ${opts.network}. Options: ${Object.keys(NETWORK_PRESETS).join(', ')}`);
          const cdp = await page.createCDPSession();
          await cdp.send('Network.emulateNetworkConditions', {
            offline: opts.network === 'offline',
            downloadThroughput: preset.download,
            uploadThroughput: preset.upload,
            latency: preset.latency,
          });
          await cdp.detach();
          applied.push(`network=${opts.network}`);
        }

        if (opts.cpu) {
          const cdp = await page.createCDPSession();
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: opts.cpu });
          await cdp.detach();
          applied.push(`cpu=${opts.cpu}x`);
        }

        browser.disconnect();
        success(`Emulation: ${applied.join(', ')}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}
