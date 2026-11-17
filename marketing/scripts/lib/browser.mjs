import fs from 'node:fs';
import { chromium } from 'playwright-core';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

export function findChrome(config) {
  const wanted = config.capture.browserPath;
  if (wanted) {
    if (!fs.existsSync(wanted)) throw new Error(`capture.browserPath does not exist: ${wanted}`);
    return wanted;
  }
  const found = CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) throw new Error('No Chrome or Edge found. Set CHROME_PATH or capture.browserPath.');
  return found;
}

export async function launchBrowser(config, { headless = config.capture.headless } = {}) {
  return chromium.launch({
    executablePath: findChrome(config),
    headless,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--force_high_performance_gpu',
      '--force-device-scale-factor=1',
      '--hide-scrollbars',
      '--mute-audio',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
      '--autoplay-policy=no-user-gesture-required',
      ...(config.capture.extraBrowserArgs || []),
    ],
  });
}
