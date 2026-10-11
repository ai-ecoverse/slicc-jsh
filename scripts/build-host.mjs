#!/usr/bin/env node
/**
 * Build the package `bin` (host jsh):
 * - dist/host/jsh.mjs — thin launcher (kernel handoff or load host impl)
 * - dist/host/jsh-host.mjs — host Node implementation (child_process, vm, …)
 *
 * Runs after scripts/build.mjs, which empties dist/.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hostDir = join(root, 'dist/host');
mkdirSync(hostDir, { recursive: true });

const launcher = join(hostDir, 'jsh.mjs');
const impl = join(hostDir, 'jsh-host.mjs');

// Launcher: leave relative imports to ../jsh.mjs and ./jsh-host.mjs external
// so the kernel path never loads child_process.
await esbuild.build({
  entryPoints: [join(root, 'src/host/jsh.mjs')],
  outfile: launcher,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  packages: 'external',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
  plugins: [
    {
      name: 'external-relative-host',
      setup(build) {
        build.onResolve({ filter: /^\.\/jsh-host\.mjs$/ }, () => ({
          path: './jsh-host.mjs',
          external: true,
        }));
        build.onResolve({ filter: /^\.\.\/jsh\.mjs$/ }, () => ({
          path: '../jsh.mjs',
          external: true,
        }));
      },
    },
  ],
});
chmodSync(launcher, 0o755);

await esbuild.build({
  entryPoints: [join(root, 'src/host/jsh-host.mjs')],
  outfile: impl,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  logLevel: 'info',
});

console.log('built dist/host/jsh.mjs and dist/host/jsh-host.mjs');
