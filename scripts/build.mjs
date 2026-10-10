#!/usr/bin/env node
/**
 * Bundle each abi:js entry to a single file. slicc-kernel loads JS program
 * modules via data: URLs, which cannot resolve relative imports.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

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

console.log('built dist/node.mjs and dist/jsh.mjs');
