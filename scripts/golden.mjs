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
 * with an older one installed only the host run is checked. case.json
 * `hostPlatform` ("linux"): the only platform whose host Node output the
 * golden is, recorded and checked there only.
 *
 * Fixtures run GOLDEN_JOBS at a time (default: the CPU count, at most 6);
 * each one's output is printed in fixture order once it is done.
 *
 * Usage:
 *   node scripts/golden.mjs record [fixture…]
 *   node scripts/golden.mjs check  [fixture…]
 */
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
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

const MAX_BUFFER = 4 * 1024 * 1024;

// A run fails when it stops making progress, not at a set time: QUIET_MS
// with no output from it, or MAX_MS in all, for one that keeps printing and
// never ends. A loaded runner makes a run slower; it doesn't make it quiet.
// (The longest quiet stretch of a fixture today is 4.2 s, http-server-timeouts-close.)
const QUIET_MS = 30_000;
const MAX_MS = 300_000;

/** Watches a run: `seen(chunk)` on its output; `fail(error)` once, on no progress. */
function watchdog(label, fail) {
  const start = Date.now();
  let last = start;
  let tail = '';
  let failed = false;
  const stop = () => {
    clearInterval(quiet);
    clearTimeout(outer);
  };
  const give = (message) => {
    if (failed) return;
    failed = true;
    stop();
    const error = new Error(`${label}: ${message} after ${Math.round((Date.now() - start) / 1000)} s; ${tail ? `it last printed ${JSON.stringify(tail)}` : 'it printed nothing'}`);
    error.code = 'ETIMEDOUT';
    fail(error);
  };
  const quiet = setInterval(() => {
    if (Date.now() - last >= QUIET_MS) give(`no output for ${QUIET_MS / 1000} s`);
  }, 1000);
  const outer = setTimeout(() => give(`still running`), MAX_MS);
  return {
    seen(chunk) {
      last = Date.now();
      tail = (tail + String(chunk)).slice(-120);
    },
    stop,
  };
}

// spawnSync's semantics without blocking the other fixtures: stdin is a pipe
// with case.json `stdin` (else closed at once), and no progress (SIGTERM,
// then ETIMEDOUT) or more than MAX_BUFFER on stdout or stderr throws, so a
// hung run is never recorded or compared as a golden.
function runNode22(argv, { cwd, stdin, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(node22Bin(), argv, {
      // As under npx: Node's own messages name it `node`.
      argv0: 'node',
      cwd: cwd ?? root,
      // case.json `env` applies to Node too (on top of the caller's, less the
      // colour switches: the shim's environment has none unless the case sets them).
      env: node22Env({ ...withoutColorEnv(process.env), npm_config_yes: 'true', ...env }),
    });
    const out = { stdout: [], stderr: [] };
    let size = 0;
    let overflow = false;
    let stuck = null;
    const watch = watchdog(`host ${argv.join(' ')}`, (error) => {
      stuck = error;
      child.kill();
    });
    for (const name of ['stdout', 'stderr']) {
      child[name].on('data', (chunk) => {
        watch.seen(chunk);
        size += chunk.length;
        if (size > MAX_BUFFER && !overflow) {
          overflow = true;
          child.kill();
        }
        out[name].push(chunk);
      });
    }
    child.on('error', (error) => {
      watch.stop();
      reject(error);
    });
    child.on('close', (status) => {
      watch.stop();
      if (overflow) return reject(new Error(`${argv.join(' ')}: output over ${MAX_BUFFER} bytes`));
      if (stuck) return reject(stuck);
      resolve({
        status: status ?? 1,
        stdout: Buffer.concat(out.stdout),
        stderr: Buffer.concat(out.stderr),
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin !== undefined ? Buffer.from(stdin) : undefined);
  });
}

async function runShim(argv, { files = [], env = {}, stdin } = {}) {
  const kernel = await createNodeKernel();
  const base = '/node_modules/@ai-ecoverse/slicc-jsh';
  try {
    for (const [rel, data] of packageFiles()) {
      await kernel.writeFile(`${base}/${rel}`, data);
    }
    for (const { path, data } of files) {
      await kernel.writeFile(path, data);
    }
    let watch;
    const stuck = new Promise((_, reject) => (watch = watchdog('shim', reject)));
    const work = kernel.run(['node', ...argv], {
      cwd: '/os',
      env: { ...env },
      ...(stdin !== undefined ? { stdin } : {}),
      onStdout: watch.seen,
      onStderr: watch.seen,
    });
    const result = await Promise.race([work, stuck]).finally(watch.stop);
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

// One fixture's report: its lines, printed in order when it is done, and
// whether it failed.
function report() {
  const lines = [];
  return {
    lines,
    failed: false,
    log(message) {
      lines.push(['log', message]);
    },
    fail(message) {
      lines.push(['error', message]);
      this.failed = true;
    },
  };
}

function compare(out, name, label, actual, expected) {
  if (actual.status !== expected.status) {
    out.fail(`${name} [${label}]: status ${actual.status} !== ${expected.status}`);
  }
  if (!same(actual.stdout, expected.stdout)) {
    out.fail(
      `${name} [${label}]: stdout mismatch\n--- expected ---\n${expected.stdout.toString('utf8')}\n--- actual ---\n${actual.stdout.toString('utf8')}`
    );
  }
  if (!same(actual.stderr, expected.stderr)) {
    out.fail(
      `${name} [${label}]: stderr mismatch\n--- expected ---\n${expected.stderr.toString('utf8')}\n--- actual ---\n${actual.stderr.toString('utf8')}`
    );
  }
}

async function fixture(name) {
  const out = report();
  const { dir, meta } = loadCase(name);
  const cwd = meta.cwd ? join(dir, meta.cwd) : dir;
  const argv = meta.argv;
  // An empty argv (plain `node`) needs stdin to read the program from.
  if (!Array.isArray(argv) || (argv.length === 0 && meta.stdin === undefined)) {
    out.fail(`${name}: case.json argv must be a non-empty array (or empty, with stdin)`);
    return { out, ran: false };
  }

  const hostArgv = meta.hostArgv ?? argv;
  const shimArgv = meta.shimArgv ?? argv;

  // case.json `hostPlatform` ("linux"): Node's own output depends on the
  // platform (fs.watch: inotify), so the host side is recorded and checked
  // only there; the shim side is checked everywhere.
  const hostHere = !meta.hostPlatform || meta.hostPlatform === process.platform;
  if (mode === 'record' && !hostHere) {
    out.log(`${name}: not recorded (host output is ${meta.hostPlatform}'s; this is ${process.platform})`);
    return { out, ran: false };
  }
  if (mode === 'record') {
    const recorded = await runNode22(hostArgv, { cwd, stdin: meta.stdin, env: meta.env });
    writeGolden(dir, recorded);
    out.log(
      `recorded ${name}: status=${recorded.status} out=${recorded.stdout.length}B err=${recorded.stderr.length}B`
    );
    return { out, ran: true };
  }

  for (const f of ['stdout.bin', 'stderr.bin', 'status.txt']) {
    if (!existsSync(join(dir, f))) {
      out.fail(`${name}: missing golden ${f} (run golden:record)`);
      return { out, ran: true };
    }
  }
  const expected = readGolden(dir);
  if (hostHere) {
    const host = await runNode22(hostArgv, { cwd, stdin: meta.stdin, env: meta.env });
    compare(out, name, 'host', host, expected);
  } else {
    out.log(`${name}: host skipped (its output is ${meta.hostPlatform}'s; this is ${process.platform})`);
  }

  if (meta.shim && meta.kernel && !atLeast(kernelVersion, meta.kernel)) {
    out.log(`${name}: shim skipped (slicc-kernel ${kernelVersion} < ${meta.kernel})`);
  } else if (meta.shim) {
    const files = [
      ...fixtureTree(dir),
      // case.json `packages`: devDependencies to install in the kernel
      // (e.g. @ai-ecoverse/wasm-bash for /bin/sh).
      ...(meta.packages ?? []).flatMap((pkg) =>
        devPackageFiles(pkg).map(([path, data]) => ({ path, data }))
      ),
      ...(meta.files ?? []).map((f) => ({
        path: f.path,
        data: readFileSync(join(dir, f.from)),
      })),
    ];
    const shim = await runShim(shimArgv, { files, env: meta.env ?? {}, stdin: meta.stdin });
    compare(out, name, 'shim', shim, expected);
  }

  if (!out.failed) out.log(`ok ${name}`);
  return { out, ran: true };
}

const jobs = Math.max(
  1,
  Number(process.env.GOLDEN_JOBS) || Math.min(6, availableParallelism())
);

async function main() {
  const names = listFixtures();
  const done = new Array(names.length);
  let next = 0;
  let printed = 0;
  let ran = 0;
  let failed = false;
  // Print finished fixtures in order, as soon as every one before them is done.
  const flush = () => {
    while (printed < names.length && done[printed]) {
      const { out, ran: counted } = done[printed];
      for (const [level, line] of out.lines) console[level](line);
      if (out.failed) failed = true;
      if (counted) ran++;
      printed++;
    }
  };
  const worker = async () => {
    while (next < names.length) {
      const index = next++;
      const name = names[index];
      done[index] = await fixture(name).catch((error) => {
        const out = report();
        out.fail(`${name}: ${error.stack ?? error}`);
        return { out, ran: true };
      });
      flush();
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, names.length) }, worker));
  flush();

  if (ran === 0) {
    console.error('no fixtures');
    process.exit(2);
  }
  if (failed) process.exit(1);
  console.log(`golden ${mode}: ${ran} fixture(s)`);
}

await main();
