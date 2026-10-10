#!/usr/bin/env node
/**
 * Bundle each abi:js entry to a single file. slicc-kernel loads JS program
 * modules via data: URLs, which cannot resolve relative imports.
 *
 * Also builds lazy vendor CJS bundles (readable-stream, string_decoder) under
 * dist/vendor/ so require('stream') does not pay their cost for `node -e 0`.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const require = createRequire(join(root, 'package.json'));
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'vendor'), { recursive: true });

await esbuild.build({
  entryPoints: {
    node: join(root, 'src/node.mjs'),
    jsh: join(root, 'src/jsh.mjs'),
  },
  outdir: dist,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: ['es2022'],
  logLevel: 'info',
});

const sdPath = require.resolve('string_decoder/');
await esbuild.build({
  entryPoints: [require.resolve('readable-stream/lib/ours/browser.js')],
  outfile: join(dist, 'vendor/readable-stream.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  target: ['es2022'],
  mainFields: ['main', 'module', 'browser'],
  logLevel: 'info',
  alias: {
    events: require.resolve('events/'),
    string_decoder: sdPath,
    'abort-controller': require.resolve('abort-controller'),
  },
  plugins: [
    {
      name: 'string-decoder-slash',
      setup(build) {
        build.onResolve({ filter: /^string_decoder\/$/ }, () => ({ path: sdPath }));
      },
    },
  ],
});

await esbuild.build({
  entryPoints: [sdPath],
  outfile: join(dist, 'vendor/string_decoder.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  target: ['es2022'],
  mainFields: ['main', 'module'],
  logLevel: 'info',
});

console.log('built dist/node.mjs, dist/jsh.mjs, and dist/vendor/*');
