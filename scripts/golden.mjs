#!/usr/bin/env node
/**
 * Golden-output harness: run the same argv under host Node 22 and (later) the
 * slicc-jsh shim, comparing stdout/stderr/status byte-for-byte.
 *
 * PR1: host Node 22 baselines only (record + check). Shim compare lands with
 * CLI/process in PR2. Always invoke Node 22 via `npx -y node@22` so host major
 * (e.g. 24/26 on the Mac) cannot poison goldens.
 *
 * Usage:
 *   node scripts/golden.mjs record [fixture…]
 *   node scripts/golden.mjs check  [fixture…]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(root, 'test/golden/fixtures');
const mode = process.argv[2];
const only = process.argv.slice(3);

if (mode !== 'record' && mode !== 'check') {
  console.error('usage: golden.mjs record|check [fixture…]');
  process.exit(2);
}

function listFixtures() {
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => (only.length ? only.includes(name) : true))
    .sort();
}

function loadCase(name) {
  const dir = join(fixturesDir, name);
  const meta = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8'));
  return { name, dir, meta };
}

/** Run under exact Node 22.x (not the host's node major). */
function runNode22(argv, { cwd, timeoutMs = 30_000 } = {}) {
  const result = spawnSync(
    'npx',
    ['-y', 'node@22.22.0', ...argv],
    {
      cwd: cwd ?? root,
      encoding: 'buffer',
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, npm_config_yes: 'true' },
    }
  );
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
  };
}

function writeGolden(dir, out) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stdout.bin'), out.stdout);
  writeFileSync(join(dir, 'stderr.bin'), out.stderr);
  writeFileSync(join(dir, 'status.txt'), `${out.status}\n`);
}

function readGolden(dir) {
  return {
    status: Number(readFileSync(join(dir, 'status.txt'), 'utf8').trim()),
    stdout: readFileSync(join(dir, 'stdout.bin')),
    stderr: readFileSync(join(dir, 'stderr.bin')),
  };
}

function same(a, b) {
  return Buffer.compare(a, b) === 0;
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

let ran = 0;
for (const name of listFixtures()) {
  const { dir, meta } = loadCase(name);
  const cwd = meta.cwd ? join(dir, meta.cwd) : dir;
  const argv = meta.argv;
  if (!Array.isArray(argv) || argv.length === 0) {
    fail(`${name}: case.json argv must be a non-empty array`);
    continue;
  }

  if (mode === 'record') {
    const out = runNode22(argv, { cwd });
    writeGolden(dir, out);
    console.log(`recorded ${name}: status=${out.status} out=${out.stdout.length}B err=${out.stderr.length}B`);
    ran++;
    continue;
  }

  // check
  for (const f of ['stdout.bin', 'stderr.bin', 'status.txt']) {
    if (!existsSync(join(dir, f))) {
      fail(`${name}: missing golden ${f} (run golden:record)`);
      continue;
    }
  }
  const expected = readGolden(dir);
  const actual = runNode22(argv, { cwd });
  if (actual.status !== expected.status) {
    fail(`${name}: status ${actual.status} !== ${expected.status}`);
  }
  if (!same(actual.stdout, expected.stdout)) {
    fail(
      `${name}: stdout mismatch\n--- expected ---\n${expected.stdout.toString('utf8')}\n--- actual ---\n${actual.stdout.toString('utf8')}`
    );
  }
  if (!same(actual.stderr, expected.stderr)) {
    fail(
      `${name}: stderr mismatch\n--- expected ---\n${expected.stderr.toString('utf8')}\n--- actual ---\n${actual.stderr.toString('utf8')}`
    );
  }
  if (process.exitCode !== 1) console.log(`ok ${name}`);
  ran++;
}

if (ran === 0) {
  console.error('no fixtures');
  process.exit(2);
}
if (process.exitCode) process.exit(process.exitCode);
console.log(`golden ${mode}: ${ran} fixture(s)`);
