#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const issues = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    // Vendored npm fixtures keep upstream formatting (tabs); skip them.
    if (
      name === 'node_modules' ||
      name === 'dist' ||
      name === '.git' ||
      (name === 'fixtures' && relative(root, dir) === 'test')
    ) {
      continue;
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(mjs|js|json|md|yml|yaml)$/.test(name)) check(path);
  }
}

function check(path) {
  const text = readFileSync(path, 'utf8');
  const rel = relative(root, path);
  if (text.includes('\t')) issues.push(`${rel}: tab character`);
  for (const [i, line] of text.split('\n').entries()) {
    if (/[ \t]+$/.test(line)) issues.push(`${rel}:${i + 1}: trailing whitespace`);
  }
  if (path.endsWith('.json')) {
    try {
      JSON.parse(text);
    } catch (err) {
      issues.push(`${rel}: invalid JSON (${err.message})`);
    }
  }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.name !== '@ai-ecoverse/slicc-jsh') issues.push('package.json: bad name');
if (pkg.license !== 'Apache-2.0') issues.push('package.json: license must be Apache-2.0');
{
  const eng = pkg.engines?.['slicc-kernel'] ?? '';
  const m = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(eng);
  const ok =
    m &&
    (Number(m[1]) > 1 ||
      (Number(m[1]) === 1 &&
        (Number(m[2]) > 49 || (Number(m[2]) === 49 && Number(m[3]) >= 1))));
  if (!ok) {
    issues.push('package.json: engines.slicc-kernel must be >=1.49.1 (Buffer kept #312)');
  }
}
if (!pkg.files?.includes('dist') || pkg.files?.some((f) => f === 'test' || f.startsWith('test/'))) {
  issues.push('package.json: files must allowlist dist and must not ship test/');
}
for (const cmd of ['node', 'jsh']) {
  const entry = pkg.slicc?.commands?.[cmd];
  if (entry?.abi !== 'js') issues.push(`package.json: slicc.commands.${cmd}.abi must be "js"`);
  if (!entry?.module?.startsWith('dist/')) {
    issues.push(`package.json: slicc.commands.${cmd}.module must be under dist/`);
  }
}
if (pkg.slicc?.binfmt?.['.jsh'] !== 'jsh') issues.push('package.json: binfmt .jsh → jsh missing');

walk(root);
if (issues.length) {
  console.error(issues.join('\n'));
  process.exit(1);
}
console.log('lint ok');
