#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, root } from './lib.mjs';

const vars = {
  VERSION: process.env.VERSION,
  PREV: process.env.PREV,
  WORK: process.env.WORK,
  OUT: process.env.OUT,
  TOOLS: process.env.TOOLS,
  ENGINES: readJson(join(root, 'package.json')).engines['slicc-kernel'].replace(/^>=/, ''),
};
for (const [k, v] of Object.entries(vars)) if (!v) throw new Error(`prompt: $${k} is not set`);
const text = readFileSync(join(root, 'test/cert-review/review.txt'), 'utf8').replace(/\$\{(\w+)\}/g, (m, k) => vars[k] ?? m);
process.stdout.write(`${text.trimEnd()}\nRun: ${process.env.RUN_URL ?? 'local'}\n`);
