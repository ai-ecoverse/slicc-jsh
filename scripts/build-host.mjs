#!/usr/bin/env node
/**
 * Bundle the host `jsh` (the package's `bin`) for the host's own Node.
 * Runs after scripts/build.mjs, which empties dist/.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist/host/jsh.mjs');
mkdirSync(dirname(out), { recursive: true });

await esbuild.build({
  entryPoints: [join(root, 'src/host/jsh.mjs')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
chmodSync(out, 0o755);

console.log('built dist/host/jsh.mjs');
