#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readJson } from './lib.mjs';

const { values, positionals } = parseArgs({
  options: { work: { type: 'string' }, tree: { type: 'string', default: 'tag' }, kernel: { type: 'string', default: 'new' } },
  allowPositionals: true,
});
const stage = readJson(join(resolve(values.work), 'stage.json'));
const kernel = stage.kernels.find((k) => k.id === values.kernel || k.names.includes(values.kernel));
const tree = stage.trees[values.tree];
if (!kernel || !tree || !positionals.length) {
  console.error('usage: rerun.mjs --work <dir> --tree tag|neg --kernel <id> -- <command…>');
  process.exit(2);
}
rmSync(join(tree, 'node_modules'), { force: true });
symlinkSync(kernel.modules, join(tree, 'node_modules'));
console.log(`rerun: ${values.tree} tree, kernel ${kernel.id} (${kernel.version}, users enforce): ${positionals.join(' ')}`);
const r = spawnSync(positionals[0], positionals.slice(1), { cwd: tree, stdio: ['ignore', 'inherit', 'inherit'], timeout: 20 * 60_000 });
process.exit(r.status ?? 1);
