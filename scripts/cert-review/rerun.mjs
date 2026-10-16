#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readJson } from './lib.mjs';

const { values, positionals } = parseArgs({
  options: { work: { type: 'string' }, tree: { type: 'string', default: 'tag' }, kernel: { type: 'string', default: 'new' } },
  allowPositionals: true,
});
const work = resolve(values.work);
const stage = readJson(join(work, 'stage.json'));
const kernel = stage.kernels.find((k) => k.id === values.kernel || k.names.includes(values.kernel));
const source = stage.trees[values.tree];
if (!kernel || !source || !positionals.length) {
  console.error('usage: rerun.mjs --work <dir> --tree tag|neg --kernel <id> -- <command…>');
  process.exit(2);
}
const tree = join(work, 'rerun', `${values.tree}-${kernel.id}`);
if (!existsSync(join(tree, 'package.json'))) {
  mkdirSync(tree, { recursive: true });
  cpSync(source, tree, { recursive: true, verbatimSymlinks: true, filter: (src) => src !== join(source, 'node_modules') });
  symlinkSync(kernel.modules, join(tree, 'node_modules'));
}
console.log(`rerun: ${values.tree} tree, kernel ${kernel.id} (${kernel.version}, users enforce), in ${tree}: ${positionals.join(' ')}`);
const r = spawnSync(positionals[0], positionals.slice(1), { cwd: tree, stdio: ['ignore', 'inherit', 'inherit'], timeout: 20 * 60_000 });
process.exit(r.status ?? 1);
