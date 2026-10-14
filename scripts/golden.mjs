#!/usr/bin/env node
/**
 * Golden-output harness: run the same argv under host Node 22 and (when
 * case.json has `"shim": true`) under the slicc-jsh shim in slicc-kernel's
 * Node entry. stdout/stderr/status compared byte-for-byte.
 *
 * Always run host Node 22.22.0 (scripts/node22.mjs: $NODE22, else fetched once
 * with `npx -y node@22.22.0`) so host major cannot poison
 * goldens. Fixtures live under test/golden/fixtures/ and are not published.
 * case.json `kernel` ("1.86.0"): the oldest slicc-kernel the shim run needs;
 * with an older one installed only the host run is checked.
 *
 * Usage:
 *   node scripts/golden.mjs record [fixture…]
 *   node scripts/golden.mjs check  [fixture…]
 */
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '@ai-ecoverse/slicc-kernel/node';
import { node22Bin, node22Env } from './node22.mjs';
import { devPackageFiles, packageFiles } from '../test/integration/helpers.mjs';

const SKIP_NAMES = new Set([
  'case.json',
  'stdout.bin',
  'stderr.bin',
  'status.txt',
]);

/** Fixture files (scripts, node_modules, …) to place under /os in the shim. */
function fixtureTree(dir) {
  const out = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      if (SKIP_NAMES.has(name)) continue;
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        const rel = relative(dir, path).replaceAll('\\', '/');
        out.push({ path: `/os/${rel}`, data: readFileSync(path) });
      }
    }
  };
  walk(dir);
  return out;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// The installed slicc-kernel, for case.json `kernel`: the oldest kernel the
// shim side needs (a feature an older kernel lacks, where jsh falls back).
// On an older one only the host side is checked.
const kernelVersion = JSON.parse(
  readFileSync(join(root, 'node_modules/@ai-ecoverse/slicc-kernel/package.json'), 'utf8')
).version;
const atLeast = (version, min) => {
  const a = version.split(/[.-]/).map(Number);
  const b = min.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
};
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

function withoutColorEnv(env) {
  const { NO_COLOR, FORCE_COLOR, NODE_DISABLE_COLORS, ...rest } = env;
  return rest;
}

function runNode22(argv, { cwd, stdin, env = {}, timeoutMs = 30_000 } = {}) {
  const result = spawnSync(node22Bin(), argv, {
    // As under npx: Node's own messages name it `node`.
    argv0: 'node',
    cwd: cwd ?? root,
    // case.json `stdin`: a pipe with that text (else none, as before).
    ...(stdin !== undefined ? { input: Buffer.from(stdin) } : {}),
    encoding: 'buffer',
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    // case.json `env` applies to Node too (on top of the caller's, less the
    // colour switches: the shim's environment has none unless the case sets them).
    env: node22Env({ ...withoutColorEnv(process.env), npm_config_yes: 'true', ...env }),
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
  };
}

async function runShim(argv, { files = [], env = {}, stdin, timeoutMs = 30_000 } = {}) {
  const kernel = await createNodeKernel();
  const base = '/node_modules/@ai-ecoverse/slicc-jsh';
  try {
    for (const [rel, data] of packageFiles()) {
      await kernel.writeFile(`${base}/${rel}`, data);
    }
    for (const { path, data } of files) {
      await kernel.writeFile(path, data);
    }
    const work = kernel.run(['node', ...argv], { cwd: '/os', env: { ...env }, ...(stdin !== undefined ? { stdin } : {}) });
    const result = await Promise.race([
      work,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`shim timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
    return {
      status: result.status,
      stdout: Buffer.from(result.stdout),
      stderr: Buffer.from(result.stderr),
    };
  } finally {
    kernel.terminate();
  }
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

function compare(name, label, actual, expected) {
  if (actual.status !== expected.status) {
    fail(`${name} [${label}]: status ${actual.status} !== ${expected.status}`);
  }
  if (!same(actual.stdout, expected.stdout)) {
    fail(
      `${name} [${label}]: stdout mismatch\n--- expected ---\n${expected.stdout.toString('utf8')}\n--- actual ---\n${actual.stdout.toString('utf8')}`
    );
  }
  if (!same(actual.stderr, expected.stderr)) {
    fail(
      `${name} [${label}]: stderr mismatch\n--- expected ---\n${expected.stderr.toString('utf8')}\n--- actual ---\n${actual.stderr.toString('utf8')}`
    );
  }
}

async function main() {
  let ran = 0;
  for (const name of listFixtures()) {
    const { dir, meta } = loadCase(name);
    const cwd = meta.cwd ? join(dir, meta.cwd) : dir;
    const argv = meta.argv;
    // An empty argv (plain `node`) needs stdin to read the program from.
    if (!Array.isArray(argv) || (argv.length === 0 && meta.stdin === undefined)) {
      fail(`${name}: case.json argv must be a non-empty array (or empty, with stdin)`);
      continue;
    }

    const hostArgv = meta.hostArgv ?? argv;
    const shimArgv = meta.shimArgv ?? argv;

    if (mode === 'record') {
      const out = runNode22(hostArgv, { cwd, stdin: meta.stdin, env: meta.env });
      writeGolden(dir, out);
      console.log(`recorded ${name}: status=${out.status} out=${out.stdout.length}B err=${out.stderr.length}B`);
      ran++;
      continue;
    }

    for (const f of ['stdout.bin', 'stderr.bin', 'status.txt']) {
      if (!existsSync(join(dir, f))) {
        fail(`${name}: missing golden ${f} (run golden:record)`);
        continue;
      }
    }
    const expected = readGolden(dir);
    const host = runNode22(hostArgv, { cwd, stdin: meta.stdin, env: meta.env });
    compare(name, 'host', host, expected);

    if (meta.shim && meta.kernel && !atLeast(kernelVersion, meta.kernel)) {
      console.log(`${name}: shim skipped (slicc-kernel ${kernelVersion} < ${meta.kernel})`);
    } else if (meta.shim) {
      const files = [
        ...fixtureTree(dir),
        // case.json `packages`: devDependencies to install in the kernel
        // (e.g. @ai-ecoverse/wasm-bash for /bin/sh).
        ...(meta.packages ?? []).flatMap((name) =>
          devPackageFiles(name).map(([path, data]) => ({ path, data }))
        ),
        ...(meta.files ?? []).map((f) => ({
          path: f.path,
          data: readFileSync(join(dir, f.from)),
        })),
      ];
      const shim = await runShim(shimArgv, { files, env: meta.env ?? {}, stdin: meta.stdin });
      compare(name, 'shim', shim, expected);
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
}

await main();
