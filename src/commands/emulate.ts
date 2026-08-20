import { Command } from 'commander';
import { intArg, floatArg } from '../util/parsers.js';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { success, error } from '../output/formatter.js';
import { KnownDevices } from 'puppeteer-core';
import * as store from '../core/session-store.js';
import type { EmulationState } from '../core/session-store.js';
import { applyEmulation, clearEmulation, getDevice, getNetworkPreset, networkPresetNames } from '../cdp/emulation.js';

export function registerEmulateCommand(program: Command): void {
  program
    .command('emulate')
    .description('Emulate device, network, or CPU')
    .option('-s, --session <name>', 'Session name')
    .option('--device <name>', 'Device preset (e.g. "iPhone 14")')
    .option('--viewport <wxh>', 'Set viewport size, e.g. 1920x1080. Persists like other emulation.')
    .option('--network <profile>', 'Network preset (slow-3g|fast-3g|4g|offline)')
    .option('--cpu <rate>', 'CPU throttle rate (e.g. 4 = 4x slowdown)', floatArg)
    .option('--dpr <n>', 'Device pixel ratio override', floatArg)
    .option('--user-agent <ua>', 'User-Agent override (empty string clears)')
    .option('--color-scheme <scheme>', 'prefers-color-scheme: light|dark|no-preference')
    .option('--geolocation <coords>', 'Geolocation override "<lat>,<lng>" (e.g. "37.5,127.0")')
    .option('--geolocation-accuracy <m>', 'Geolocation accuracy radius in meters (default 50)', floatArg)
    .option('--reset', 'Clear all emulation overrides')
    .option('--list-devices', 'List available device presets')
    .action(async (opts) => {
      if (opts.listDevices) {
        const names = Object.keys(KnownDevices);
        names.forEach(n => console.log(n));
        return;
      }

      try {
        const { browser, meta } = await connect(opts.session);
        const page = await getActivePage(browser);

        if (opts.reset) {
          await clearEmulation(page);
          browser.disconnect();
          store.update(meta.name, { emulation: undefined });
          success('Emulation: cleared');
          return;
        }

        const nextEmu: EmulationState = { ...(meta.emulation ?? {}) };
        const applied: string[] = [];

        if (opts.device) {
          const device = getDevice(opts.device);
          if (!device) throw new Error(`Unknown device: ${opts.device}. Use --list-devices`);
          nextEmu.device = opts.device;
          nextEmu.viewport = {
            width: device.viewport.width,
            height: device.viewport.height,
            deviceScaleFactor: device.viewport.deviceScaleFactor ?? 1,
            mobile: device.viewport.isMobile ?? false,
          };
          applied.push(`device=${opts.device}`);
        }

        if (opts.viewport) {
          const m = /^(\d+)x(\d+)$/.exec(opts.viewport);
          if (!m) throw new Error(`--viewport must be <width>x<height>, got "${opts.viewport}"`);
          const w = Number(m[1]);
          const h = Number(m[2]);
          // device 설정과 결합 가능 — device의 dsf/mobile 유지하고 width/height만 덮어씀
          const base = nextEmu.viewport ?? { width: w, height: h, deviceScaleFactor: 1, mobile: false };
          nextEmu.viewport = { ...base, width: w, height: h };
          // explicit viewport overrides device viewport but keeps device UA/touch via emu.device
          applied.push(`viewport=${w}x${h}`);
        }

        if (opts.network) {
          if (!getNetworkPreset(opts.network)) {
            throw new Error(`Unknown network: ${opts.network}. Options: ${networkPresetNames().join(', ')}`);
          }
          nextEmu.network = opts.network;
          applied.push(`network=${opts.network}`);
        }

        if (opts.cpu !== undefined) {
          nextEmu.cpu = opts.cpu;
          applied.push(`cpu=${opts.cpu}x`);
        }

        if (opts.dpr !== undefined) {
          // DPR requires a viewport context — preserve any existing one (from device or prior --dpr),
          // otherwise capture the current window size as the baseline.
          let base = nextEmu.viewport;
          if (!base) {
            const size = await page.evaluate(() => ({
              w: window.innerWidth,
              h: window.innerHeight,
            }));
            base = { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false };
          }
          nextEmu.viewport = { ...base, deviceScaleFactor: opts.dpr };
          applied.push(`dpr=${opts.dpr}x`);
        }

        if (opts.userAgent !== undefined) {
          nextEmu.userAgent = opts.userAgent;
          applied.push(opts.userAgent === '' ? 'user-agent=cleared' : `user-agent=${opts.userAgent.slice(0, 40)}${opts.userAgent.length > 40 ? '…' : ''}`);
        }

        if (opts.colorScheme !== undefined) {
          if (!['light', 'dark', 'no-preference'].includes(opts.colorScheme)) {
            throw new Error(`--color-scheme must be light|dark|no-preference, got "${opts.colorScheme}"`);
          }
          nextEmu.colorScheme = opts.colorScheme;
          applied.push(`color-scheme=${opts.colorScheme}`);
        }

        if (opts.geolocation !== undefined) {
          const m = /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/.exec(opts.geolocation);
          if (!m) throw new Error(`--geolocation must be "<lat>,<lng>", got "${opts.geolocation}"`);
          const accuracy = opts.geolocationAccuracy ?? 50;
          nextEmu.geolocation = {
            latitude: Number(m[1]),
            longitude: Number(m[2]),
            accuracy,
          };
          applied.push(`geolocation=${m[1]},${m[2]} ±${accuracy}m`);
        }

        if (applied.length === 0) {
          browser.disconnect();
          throw new Error('No emulation options provided. Use --device, --viewport, --network, --cpu, --user-agent, --color-scheme, --geolocation, --reset, or --list-devices');
        }

        await applyEmulation(page, nextEmu);
        browser.disconnect();
        store.update(meta.name, { emulation: nextEmu });
        success(`Emulation: ${applied.join(', ')}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}
