// Starts the repository's own dev server (server.mjs) so captures render the same files
// that `npm start` serves.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { REPO_DIR } from './config.mjs';

export async function startServer(port) {
  const child = spawn(process.execPath, [path.join(REPO_DIR, 'server.mjs'), String(port)], {
    cwd: REPO_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  const base = `http://localhost:${port}/`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(base, { method: 'HEAD' });
      if (r.ok || r.status === 404) return { base, logs, stop: () => child.kill() };
    } catch { /* not up yet */ }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`dev server did not start on port ${port}:\n${logs.join('')}`);
}
