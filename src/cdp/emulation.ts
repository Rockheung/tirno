import type { Page } from 'puppeteer-core';
import { KnownDevices } from 'puppeteer-core';
import type { EmulationState } from '../core/session-store.js';

const NETWORK_PRESETS: Record<string, { download: number; upload: number; latency: number }> = {
  'slow-3g': { download: 500 * 1024 / 8, upload: 500 * 1024 / 8, latency: 400 },
  'fast-3g': { download: 1.6 * 1024 * 1024 / 8, upload: 750 * 1024 / 8, latency: 150 },
  '4g': { download: 4 * 1024 * 1024 / 8, upload: 3 * 1024 * 1024 / 8, latency: 20 },
  'offline': { download: 0, upload: 0, latency: 0 },
};

export function getNetworkPreset(name: string) {
  return NETWORK_PRESETS[name.toLowerCase()];
}

export function networkPresetNames(): string[] {
  return Object.keys(NETWORK_PRESETS);
}

export function getDevice(name: string) {
  return KnownDevices[name as keyof typeof KnownDevices];
}

export async function applyEmulation(page: Page, emu: EmulationState): Promise<void> {
  if (!emu.device && !emu.viewport && !emu.network && emu.cpu === undefined) return;

  if (emu.device) {
    const device = getDevice(emu.device);
    if (device) {
      // page.emulate writes setDeviceMetrics + setUserAgent + setTouchEmulation
      // through puppeteer's main CDP session, so the overrides persist for the
      // page wrapper's lifetime instead of being torn down with a temporary session.
      await page.emulate(device);
      const targetDsf = emu.viewport?.deviceScaleFactor;
      const deviceDsf = device.viewport.deviceScaleFactor ?? 1;
      if (targetDsf !== undefined && targetDsf !== deviceDsf) {
        await page.setViewport({
          width: device.viewport.width,
          height: device.viewport.height,
          deviceScaleFactor: targetDsf,
          isMobile: device.viewport.isMobile ?? false,
          hasTouch: device.viewport.hasTouch ?? false,
        });
      }
    }
  } else if (emu.viewport) {
    await page.setViewport({
      width: emu.viewport.width,
      height: emu.viewport.height,
      deviceScaleFactor: emu.viewport.deviceScaleFactor,
      isMobile: emu.viewport.mobile,
      hasTouch: emu.viewport.mobile,
    });
  }

  if (emu.network || emu.cpu !== undefined) {
    const cdp = await page.createCDPSession();
    try {
      if (emu.network) {
        const preset = NETWORK_PRESETS[emu.network.toLowerCase()];
        if (preset) {
          await cdp.send('Network.emulateNetworkConditions', {
            offline: emu.network === 'offline',
            downloadThroughput: preset.download,
            uploadThroughput: preset.upload,
            latency: preset.latency,
          });
        }
      }
      if (emu.cpu !== undefined) {
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: emu.cpu });
      }
    } finally {
      await cdp.detach();
    }
  }
}

export async function clearEmulation(page: Page): Promise<void> {
  const cdp = await page.createCDPSession();
  try {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: '' });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      downloadThroughput: -1,
      uploadThroughput: -1,
      latency: 0,
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  } finally {
    await cdp.detach();
  }
}
