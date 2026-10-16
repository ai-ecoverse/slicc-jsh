#!/usr/bin/env node
import { appendFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { SEMVER, archive, npmFlags, packTree, sh, sha, sri } from './lib.mjs';

const { values } = parseArgs({ options: { version: { type: 'string' }, out: { type: 'string' } } });
const { version } = values;
if (!SEMVER.test(version ?? '') || !values.out) {
  console.error('pack: --version x.y.z and --out <dir> are required');
  process.exit(2);
}
const out = resolve(values.out);
const ref = `v${version}`;
const tree = join(out, 'tree');
const commit = archive(tree, ref);
sh('npm', ['ci', ...npmFlags], { cwd: tree });
const made = packTree(tree, version, commit, join(out, 'tmp'), ref);
const file = join(out, basename(made));
renameSync(made, file);
rmSync(tree, { recursive: true, force: true });
const sha256 = sha('sha256', file);
writeFileSync(`${file}.sha256`, `${sha256}  ${basename(file)}\n`);
writeFileSync(join(out, 'pack.json'), `${JSON.stringify({ ref, commit, file: basename(file), sha256, integrity: sri(file) }, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha256=${sha256}\nfile=${basename(file)}\ncommit=${commit}\n`);
console.log(`pack: ${basename(file)} sha256=${sha256} from ${ref} (${commit})`);
