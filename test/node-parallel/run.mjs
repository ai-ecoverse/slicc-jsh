/**
 * Run a slice of Node v22 test/parallel against slicc-jsh.
 * Fixtures live in fixtures/; common shim in common.js + common/tmpdir.js.
 *
 * Usage: node test/node-parallel/run.mjs
 * Exit 0 always prints the pass/fail table; exit 1 if any unexpected fail
 * when STRICT=1.
 */
import { readdirSync, readFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packageFiles } from '../integration/helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');
const TIMEOUT_MS = 15_000;

/** Tests that need APIs we do not ship yet (node:test, full common, …). */
const SKIP = new Set([
  'test-assert-fail.js', // needs node:test
  'test-assert.js', // huge; needs many common helpers
  'test-buffer-alloc.js', // large; many edge paths
  'test-stream-readable-async-iterators.js', // needs common fixtures
]);

const kernelPkg = join(root, 'node_modules/@ai-ecoverse/slicc-kernel');
const kernelCopy = mkdtempSync(join(tmpdir(), 'slicc-kernel-np-'));
cpSync(join(kernelPkg, 'dist'), join(kernelCopy, 'dist'), { recursive: true });
const { createNodeKernel } = await import(pathToFileURL(join(kernelCopy, 'dist/node.js')).href);
const k = await createNodeKernel();
const jshBase = '/node_modules/@ai-ecoverse/slicc-jsh';
for (const [rel, data] of packageFiles()) {
  await k.writeFile(`${jshBase}/${rel}`, data);
}

const commonJs = readFileSync(join(here, 'common.js'));
const tmpdirJs = readFileSync(join(here, 'common/tmpdir.js'));
await k.writeFile('/os/test/common.js', commonJs);
await k.writeFile('/os/test/common/index.js', commonJs);
await k.writeFile('/os/test/common/tmpdir.js', tmpdirJs);
await k.run(['node', '-e', "require('fs').mkdirSync('/os/test/parallel',{recursive:true})"], {
  cwd: '/',
});

const files = readdirSync(fixturesDir)
  .filter((f) => f.startsWith('test-') && f.endsWith('.js'))
  .sort();

const results = [];

for (const file of files) {
  if (SKIP.has(file)) {
    results.push({ file, status: 'SKIP', ms: 0, detail: 'listed skip' });
    console.log(`# SKIP ${file}`);
    continue;
  }
  const src = readFileSync(join(fixturesDir, file));
  await k.writeFile(`/os/test/parallel/${file}`, src);
  const t0 = Date.now();
  let shim;
  try {
    shim = await Promise.race([
      k.run(['node', `/os/test/parallel/${file}`], { cwd: '/os/test/parallel' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), TIMEOUT_MS)),
    ]);
  } catch (e) {
    shim = { status: 1, stdout: '', stderr: String(e.message) };
  }
  const ms = Date.now() - t0;
  const ok = shim.status === 0 || shim.status === '0';
  const status = ok ? 'PASS' : 'FAIL';
  results.push({
    file,
    status,
    ms,
    detail: ok ? '' : (shim.stderr || shim.stdout || '').slice(0, 200).replace(/\n/g, ' '),
  });
  console.log(`# ${status} ${file} (${ms} ms)`);
  if (!ok && process.env.VERBOSE) {
    console.log(shim.stderr || shim.stdout);
  }
}

rmSync(kernelCopy, { recursive: true, force: true });

const pass = results.filter((r) => r.status === 'PASS');
const fail = results.filter((r) => r.status === 'FAIL');
const skip = results.filter((r) => r.status === 'SKIP');

console.log('');
console.log('node-parallel summary (Node v22.22.0 fixtures):');
for (const r of results) {
  console.log(`  ${r.status.padEnd(4)} ${r.file}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(
  `totals: PASS=${pass.length} FAIL=${fail.length} SKIP=${skip.length} of ${results.length}`
);

if (process.env.STRICT === '1' && fail.length) process.exit(1);
