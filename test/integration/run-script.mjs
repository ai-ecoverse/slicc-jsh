import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../..', import.meta.url));

export const caseDirs = (dir) =>
  readdirSync(join(root, dir))
    .filter((name) => statSync(join(root, dir, name)).isDirectory())
    .sort();

export function runNode(t, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=512', ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    t.signal.addEventListener('abort', kill, { once: true });
    const out = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => out.push(chunk));
    child.on('error', reject);
    child.on('close', (status, signal) => {
      t.signal.removeEventListener('abort', kill);
      kill();
      resolve({ status: status ?? signal, out: Buffer.concat(out).toString('utf8') });
    });
  });
}
