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
  if (
    !emu.device &&
    !emu.viewport &&
    !emu.network &&
    emu.cpu === undefined &&
    emu.userAgent === undefined &&
    emu.colorScheme === undefined &&
    emu.geolocation === undefined
  ) {
    return;
  }

  if (emu.device) {
    const device = getDevice(emu.device);
    if (device) {
      // page.emulate writes setDeviceMetrics + setUserAgent + setTouchEmulation
      // through puppeteer's main CDP session, so the overrides persist for the
      // page wrapper's lifetime instead of being torn down with a temporary session.
      await page.emulate(device);
      const targetDsf = emu.viewport?.deviceScaleFactor;
      const deviceDsf = device.viewport.deviceScaleFactor ?? 1;
      const targetW = emu.viewport?.width ?? device.viewport.width;
      const targetH = emu.viewport?.height ?? device.viewport.height;
      const dsfChanged = targetDsf !== undefined && targetDsf !== deviceDsf;
      const sizeChanged = targetW !== device.viewport.width || targetH !== device.viewport.height;
      if (dsfChanged || sizeChanged) {
        await page.setViewport({
          width: targetW,
          height: targetH,
          deviceScaleFactor: targetDsf ?? deviceDsf,
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

  // UA / color-scheme / geolocation must go through puppeteer's main page session
  // — page.createCDPSession() overrides are released on detach, so they don't
  // persist after `tirno emulate` exits.
  if (emu.userAgent !== undefined) {
    await page.setUserAgent(emu.userAgent);
  }
  if (emu.colorScheme !== undefined) {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: emu.colorScheme }]);
  }
  if (emu.geolocation !== undefined) {
    // Permission must be granted on the browser context for navigator.geolocation
    // to actually return the override (otherwise "User denied").
    try {
      const origin = new URL(page.url()).origin;
      await page.browserContext().overridePermissions(origin, ['geolocation']);
    } catch { /* best-effort — page may be at chrome:// or about:blank */ }
    await page.setGeolocation({
      latitude: emu.geolocation.latitude,
      longitude: emu.geolocation.longitude,
      accuracy: emu.geolocation.accuracy,
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
    await cdp.send('Emulation.setEmulatedMedia', { media: '', features: [] });
    await cdp.send('Emulation.clearGeolocationOverride');
  } finally {
    await cdp.detach();
  }
}
