#!/usr/bin/env node
/**
 * Build the host `jsh` (the package's `bin`) for the host's own Node:
 * dist/host/main.mjs, the bundled host CLI, and dist/host/jsh.mjs, the
 * launcher (src/host/launcher.mjs, copied as is) that imports it on a real
 * host and hands off to the kernel jsh inside slicc-kernel.
 * Runs after scripts/build.mjs, which empties dist/.
 */
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist/host');
mkdirSync(out, { recursive: true });

await esbuild.build({
  entryPoints: [join(root, 'src/host/main.mjs')],
  outfile: join(out, 'main.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  logLevel: 'info',
});
copyFileSync(join(root, 'src/host/launcher.mjs'), join(out, 'jsh.mjs'));
chmodSync(join(out, 'jsh.mjs'), 0o755);

console.log('built dist/host/main.mjs and dist/host/jsh.mjs');
