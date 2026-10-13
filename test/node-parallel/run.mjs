/**
 * Run a slice of Node v22.22.0 test/parallel against slicc-jsh using Node's
 * real test/common (vendored under node-common/). Only net and worker_threads
 * are stubbed (M1 gaps), matching hb2's approach.
 *
 * Usage: node test/node-parallel/run.mjs
 * skip() → SKIP (not PASS). STRICT=1 exits 1 on any FAIL.
 */
import { readdirSync, readFileSync, mkdtempSync, cpSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packageFiles } from '../integration/helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');
const nodeCommonDir = join(here, 'node-common');
const TIMEOUT_MS = 20_000;

if (!existsSync(join(nodeCommonDir, 'index.js'))) {
  console.error('missing test/node-parallel/node-common (Node v22.22.0 test/common)');
  process.exit(2);
}

const kernelPkg = join(root, 'node_modules/@ai-ecoverse/slicc-kernel');
const kernelCopy = mkdtempSync(join(tmpdir(), 'slicc-kernel-np-'));
cpSync(join(kernelPkg, 'dist'), join(kernelCopy, 'dist'), { recursive: true });
const { createNodeKernel } = await import(pathToFileURL(join(kernelCopy, 'dist/node.js')).href);
const k = await createNodeKernel();
const jshBase = '/node_modules/@ai-ecoverse/slicc-jsh';
for (const [rel, data] of packageFiles()) {
  await k.writeFile(`${jshBase}/${rel}`, data);
}

await k.run(
  [
    'node',
    '-e',
    "require('fs').mkdirSync('/os/test/common',{recursive:true}); require('fs').mkdirSync('/os/test/parallel',{recursive:true}); require('fs').mkdirSync('/os/test/fixtures',{recursive:true})",
  ],
  { cwd: '/' }
);

const stubs = {
  'net-stub.js': readFileSync(join(here, 'net-stub.js')),
  'worker_threads-stub.js': readFileSync(join(here, 'worker_threads-stub.js')),
  'child_process-stub.js': readFileSync(join(here, 'child_process-stub.js')),
  'node-test-stub.js': readFileSync(join(here, 'node-test-stub.js')),
};
for (const [name, data] of Object.entries(stubs)) {
  await k.writeFile(`/os/test/common/${name}`, data);
}

function patchCommonRequires(text) {
  return text
    .replace(/require\(['"]net['"]\)/g, "require('./net-stub')")
    .replace(/require\(['"]worker_threads['"]\)/g, "require('./worker_threads-stub')")
    .replace(/require\(['"]child_process['"]\)/g, "require('./child_process-stub')")
    // slicc-jsh has crypto but no OpenSSL (no process.versions.openssl): run
    // the crypto tests as if on Node's OpenSSL 3.0.
    .replace('Boolean(process.versions.openssl)', 'true')
    .replace("require('cluster').isPrimary &&", '')
    .replace('process.versions.openssl.match(regexp)', "'3.0.15+quic'.match(regexp)");
}

for (const name of readdirSync(nodeCommonDir)) {
  const hp = join(nodeCommonDir, name);
  if (!statSync(hp).isFile()) continue;
  if (name.endsWith('.mjs')) continue;
  let data = readFileSync(hp);
  if (name === 'index.js' || name === 'tmpdir.js' || name === 'crypto.js') {
    data = Buffer.from(patchCommonRequires(data.toString('utf8')));
  }
  await k.writeFile(`/os/test/common/${name}`, data);
}

// The few Node v22.22.0 test/fixtures files the fixtures read.
const nodeFixturesDir = join(here, 'node-fixtures');
const copyFixtures = async (dir, rel) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) await copyFixtures(p, `${rel}${name}/`);
    else await k.writeFile(`/os/test/fixtures/${rel}${name}`, readFileSync(p));
  }
};
await copyFixtures(nodeFixturesDir, '');

const files = readdirSync(fixturesDir)
  .filter((f) => f.startsWith('test-') && f.endsWith('.js'))
  // ONLY=<regex> runs a subset (e.g. ONLY=crypto).
  .filter((f) => !process.env.ONLY || new RegExp(process.env.ONLY).test(f))
  .sort();

// A test's `// Flags: …` line, as Node's test runner passes them (else
// test/common re-spawns itself with them through child_process).
const flagsOf = (src) => {
  const m = /^\/\/ Flags: (.+)$/m.exec(src.toString('utf8'));
  return m ? m[1].trim().split(/\s+/) : [];
};

const results = [];

for (const file of files) {
  // No node:test in slicc-jsh yet: the harness's minimal stand-in.
  const src = Buffer.from(
    readFileSync(join(fixturesDir, file), 'utf8').replace(/require\(['"]node:test['"]\)/g, "require('../common/node-test-stub')")
  );
  await k.writeFile(`/os/test/parallel/${file}`, src);
  const t0 = Date.now();
  let shim;
  try {
    shim = await Promise.race([
      k.run(['node', ...flagsOf(src), `/os/test/parallel/${file}`], { cwd: '/os/test/parallel' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), TIMEOUT_MS)),
    ]);
  } catch (e) {
    shim = { status: 1, stdout: '', stderr: String(e.message) };
  }
  const ms = Date.now() - t0;
  const out = `${shim.stdout ?? ''}${shim.stderr ?? ''}`;
  const skipped =
    /1\.\.0\s+#\s*Skipped/i.test(out) || /#\s*SKIP\b/i.test(out) || /Skipped:\s/i.test(out);
  const ok = shim.status === 0 || shim.status === '0';
  let status;
  if (skipped) status = 'SKIP';
  else if (ok) status = 'PASS';
  else status = 'FAIL';
  results.push({
    file,
    status,
    ms,
    detail: status === 'FAIL' ? out.slice(0, 220).replace(/\n/g, ' ') : '',
  });
  console.log(`# ${status} ${file} (${ms} ms)`);
  if (status === 'FAIL' && process.env.VERBOSE) console.log(out);
}

rmSync(kernelCopy, { recursive: true, force: true });

const pass = results.filter((r) => r.status === 'PASS');
const fail = results.filter((r) => r.status === 'FAIL');
const skip = results.filter((r) => r.status === 'SKIP');

console.log('');
console.log('node-parallel summary (Node v22.22.0 fixtures + real test/common):');
for (const r of results) {
  console.log(`  ${r.status.padEnd(4)} ${r.file}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(
  `totals: PASS=${pass.length} FAIL=${fail.length} SKIP=${skip.length} of ${results.length}`
);

if (process.env.STRICT === '1' && fail.length) process.exit(1);
