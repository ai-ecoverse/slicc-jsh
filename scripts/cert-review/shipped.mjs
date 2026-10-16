#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { archive, npmFlags, readJson, relFiles, root, sh, sha } from './lib.mjs';

const { values } = parseArgs({ options: { base: { type: 'string' }, head: { type: 'string' }, work: { type: 'string' } } });
const work = resolve(values.work);
mkdirSync(work, { recursive: true });
const git = (...a) => sh('git', a, { cwd: root, quiet: true }).trim();

const ALWAYS = [
  /^src\//,
  /^scripts\/build(-host)?\.mjs$/,
  /^scripts\/(strip-own-scripts|generate-notice)\.mjs$/,
  /^(LICENSE|NOTICE|README\.md|install\.sh|\.releaserc\.json|\.npmrc|\.npmignore)$/,
  /^\.github\/workflows\/release\.yml$/,
];
const MANIFEST = /^package(-lock)?\.json$/;
const SHIPPED_FIELDS = ['name', 'type', 'bin', 'main', 'exports', 'files', 'engines', 'slicc', 'dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies', 'publishConfig'];

const files = git('diff', '--name-only', values.base, values.head).split('\n').filter(Boolean);
const direct = files.filter((f) => ALWAYS.some((re) => re.test(f)));
const manifest = files.filter((f) => MANIFEST.test(f));
let behaviour = direct.length > 0;
let why = direct.length ? `shipped files changed: ${direct.slice(0, 8).join(', ')}${direct.length > 8 ? ', …' : ''}` : '';

function distOf(ref, dir, devDependenciesFrom) {
  archive(dir, ref);
  sh('npm', ['ci', '--ignore-scripts', ...npmFlags], { cwd: dir });
  if (devDependenciesFrom) {
    const p = readJson(join(dir, 'package.json'));
    p.devDependencies = JSON.parse(git('show', `${devDependenciesFrom}:package.json`)).devDependencies;
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(p, null, 2)}\n`);
  }
  sh('npm', ['run', 'build'], { cwd: dir });
  const out = {};
  for (const f of relFiles(join(dir, 'dist'))) if (!/^meta-.*\.json$/.test(f)) out[f] = sha('sha256', join(dir, 'dist', f));
  out['NOTICE'] = sha('sha256', join(dir, 'NOTICE'));
  return out;
}

if (!behaviour && manifest.length) {
  const shipped = (ref) => {
    const p = JSON.parse(git('show', `${ref}:package.json`));
    return JSON.stringify(SHIPPED_FIELDS.map((k) => [k, p[k] ?? null]));
  };
  if (shipped(values.base) !== shipped(values.head)) {
    behaviour = true;
    why = "package.json's shipped fields changed (dependencies, bin, exports, files, engines, slicc, publishConfig)";
  } else {
    const a = distOf(values.base, join(work, 'base'));
    const b = distOf(values.head, join(work, 'head'), values.base);
    const differ = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => a[f] !== b[f]).sort();
    if (differ.length) {
      behaviour = true;
      why = `a dependency change changes the build: ${differ.slice(0, 8).join(', ')}${differ.length > 8 ? ', …' : ''}`;
    } else why = `only devDependencies changed (${manifest.join(', ')}), and dist/ and NOTICE build identical on the base and the head`;
  }
}
if (!behaviour && !why) why = files.length ? `not behaviour: no shipped file changed (${files.length} file(s): tests, docs, CI)` : 'not behaviour: no change';
const result = { base: values.base, head: values.head, behaviour, why, files };
writeFileSync(join(work, 'shipped.json'), `${JSON.stringify(result, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `behaviour=${behaviour}\nwhy=${why.replace(/\n/g, ' ')}\n`);
if (!behaviour && !why.startsWith('not behaviour')) result.why = why = `not behaviour: ${why}`;
writeFileSync(join(work, 'shipped.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(`shipped: ${behaviour ? 'behaviour' : 'not behaviour'}: ${why}`);
