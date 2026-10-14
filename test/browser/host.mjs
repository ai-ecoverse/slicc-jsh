/**
 * The host jsh, for comparison: `dist/host/jsh.mjs` on this Node, with
 * `sliccy:browser` installed where `pnpm add -g` would put it (a pnpm ≥ 11
 * global group under a throwaway PNPM_HOME), as in the kernel.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostJsh = fileURLToPath(new URL('../../dist/host/jsh.mjs', import.meta.url));

export function hostJshWith(spec) {
  const home = mkdtempSync(join(tmpdir(), 'jsh-browser-pnpm-'));
  const group = join(home, 'global/v11/1-host-0');
  mkdirSync(group, { recursive: true });
  writeFileSync(join(group, 'package.json'), '{ "private": true }\n');
  execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--no-package-lock', spec], {
    cwd: group,
    stdio: 'pipe',
  });
  return {
    home,
    /**
     * `jsh <args>` in `cwd`; asynchronous, since the site a script drives
     * may be served by this very process.
     */
    run(args, { cwd, env = {}, timeout = 60_000 } = {}) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, [hostJsh, ...args], {
          cwd,
          env: { ...process.env, PNPM_HOME: home, ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => (stdout += c));
        child.stderr.on('data', (c) => (stderr += c));
        const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
        child.on('close', (status) => {
          clearTimeout(timer);
          resolve({ status: status ?? 124, stdout, stderr });
        });
      });
    },
    close: () => rmSync(home, { recursive: true, force: true }),
  };
}
