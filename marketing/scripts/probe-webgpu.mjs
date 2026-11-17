// Prints the WebGPU adapter the capture browser gets, so a capture never runs on a
// software rasterizer by accident. WebGPU needs a secure context, so this loads a page
// from the local dev server.
//   node scripts/probe-webgpu.mjs [--headed]
import { launchBrowser } from './lib/browser.mjs';
import { loadConfig } from './lib/config.mjs';
import { startServer } from './lib/server.mjs';

export async function probeAdapter(page) {
  return page.evaluate(async () => {
    if (!navigator.gpu) return { webgpu: false };
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { webgpu: true, adapter: null };
    const i = adapter.info || {};
    return {
      webgpu: true,
      vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description,
      isFallbackAdapter: Boolean(adapter.isFallbackAdapter ?? i.isFallbackAdapter),
    };
  });
}

export function assertHardwareAdapter(info) {
  if (!info.webgpu) throw new Error('WebGPU is not available in the capture browser.');
  if (!info.vendor && !info.description) throw new Error('No WebGPU adapter was returned.');
  const text = `${info.vendor} ${info.architecture} ${info.description}`.toLowerCase();
  if (info.isFallbackAdapter || /swiftshader|llvmpipe|microsoft basic|warp/.test(text)) {
    throw new Error(`WebGPU fell back to a software adapter (${text.trim()}). Enable hardware acceleration.`);
  }
}

if (process.argv[1]?.endsWith('probe-webgpu.mjs')) {
  const config = loadConfig();
  const headed = process.argv.includes('--headed') || !config.capture.headless;
  const server = await startServer(config.capture.port || 8093);
  const browser = await launchBrowser(config, { headless: !headed });
  try {
    const page = await browser.newPage();
    await page.goto(server.base + 'server.mjs');
    const info = await probeAdapter(page);
    console.log(JSON.stringify({ headless: !headed, ...info }, null, 2));
    assertHardwareAdapter(info);
    console.log('OK: hardware WebGPU adapter');
  } finally {
    await browser.close();
    server.stop();
  }
}
