#!/usr/bin/env node
/**
 * `.jsh` parity harness. The host `jsh` (dist/host/jsh.mjs on Node 22.22.0)
 * records each fixture's stdout, stderr and status; the kernel `jsh` (on
 * slicc-kernel's Node entry) must match it. See
 * docs/design/run-outside-slicc.md, "Testing".
 *
 * test/jsh/fixtures/<case>/case.json:
 *   description  what the case pins (a row of the parity tables)
 *   entry        the script to run, relative to the case (default main.jsh)
 *   args         arguments after `jsh <entry>`
 *   stdin, env   optional
 *   stderr       "exact" (default); "error-line": compare only the first
 *                `…Error: …` line, since stack frames differ between engines;
 *                "no-frames": all of it but the `    at …` frames (the source
 *                excerpt, the message, the `{ code, cause }` block)
 *   kernel       false to skip the kernel run; `kernelReason` says why
 *
 * Host runs happen in a temporary copy of the fixture, so a case can write
 * files. Usage: node scripts/jsh-golden.mjs record|check [case…]
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '@ai-ecoverse/slicc-kernel/node';
import { packageFiles } from '../test/integration/helpers.mjs';
import { node22Bin } from './node22.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(root, 'test/jsh/fixtures');
const hostJsh = join(root, 'dist/host/jsh.mjs');
const GOLDEN = new Set(['case.json', 'stdout.bin', 'stderr.bin', 'status.txt']);
const mode = process.argv[2];
const only = process.argv.slice(3);

if (mode !== 'record' && mode !== 'check') {
  console.error('usage: jsh-golden.mjs record|check [case…]');
  process.exit(2);
}
if (!existsSync(hostJsh)) {
  console.error('jsh-golden: dist/host/jsh.mjs is missing (npm run build)');
  process.exit(2);
}

function listCases() {
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => (only.length ? only.includes(name) : true))
    .sort();
}

function fixtureFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      if (current === dir && GOLDEN.has(name)) continue;
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push({ rel: relative(dir, path).replaceAll('\\', '/'), data: readFileSync(path) });
    }
  };
  walk(dir);
  return out;
}

function runHost(dir, meta) {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'jsh-golden-')));
  try {
    for (const { rel, data } of fixtureFiles(dir)) {
      mkdirSync(dirname(join(work, rel)), { recursive: true });
      writeFileSync(join(work, rel), data);
    }
    const env = { ...process.env, npm_config_yes: 'true' };
    delete env.FORCE_COLOR;
    delete env.NO_COLOR;
    Object.assign(env, meta.env ?? {});
    const result = spawnSync(node22Bin(), [hostJsh, meta.entry ?? 'main.jsh', ...(meta.args ?? [])], {
      // As under npx: Node's own messages name it `node`.
      argv0: 'node',
      cwd: work,
      input: Buffer.from(meta.stdin ?? ''),
      encoding: 'buffer',
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env,
    });
    if (result.error) throw result.error;
    // The kernel runs the case in /os; say the same for the host's copy.
    const asOs = (buf) => Buffer.from((buf ?? Buffer.alloc(0)).toString('utf8').split(work).join('/os'));
    return {
      status: result.status ?? 1,
      stdout: asOs(result.stdout),
      stderr: asOs(result.stderr),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function runKernel(dir, meta) {
  const kernel = await createNodeKernel();
  try {
    for (const [rel, data] of packageFiles()) {
      await kernel.writeFile(`/node_modules/@ai-ecoverse/slicc-jsh/${rel}`, data);
    }
    for (const { rel, data } of fixtureFiles(dir)) await kernel.writeFile(`/os/${rel}`, data);
    const work = kernel.run(['jsh', meta.entry ?? 'main.jsh', ...(meta.args ?? [])], {
      cwd: '/os',
      env: { ...(meta.env ?? {}) },
      ...(meta.stdin !== undefined ? { stdin: meta.stdin } : {}),
    });
    const result = await Promise.race([
      work,
      new Promise((_, reject) => setTimeout(() => reject(new Error('kernel timeout after 30s')), 30_000)),
    ]);
    return { status: result.status, stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr) };
  } finally {
    kernel.terminate();
  }
}

const errorLine = (buf) => /^[A-Za-z]*Error\b.*$/m.exec(buf.toString('utf8'))?.[0] ?? '';
// Stack frames differ between engines (and name engine paths); a frame line
// that carries the `{` of a props block keeps the brace.
const noFrames = (buf) =>
  buf
    .toString('utf8')
    .split('\n')
    .map((l) => (/^\s+(at |\.\.\. \d+ lines? matching).*\{$/.test(l) ? '{' : l))
    .filter((l) => !/^\s+(at |\.\.\. \d+ lines? matching)/.test(l))
    .join('\n');

function compare(name, label, actual, expected, meta) {
  const problems = [];
  if (actual.status !== expected.status) problems.push(`status ${actual.status} !== ${expected.status}`);
  if (Buffer.compare(actual.stdout, expected.stdout) !== 0) {
    problems.push(`stdout\n--- expected ---\n${expected.stdout}\n--- actual ---\n${actual.stdout}`);
  }
  let stderrOk;
  if (meta.stderr === 'error-line') {
    stderrOk = errorLine(actual.stderr) === errorLine(expected.stderr) && errorLine(expected.stderr) !== '';
  } else if (meta.stderr === 'no-frames') {
    stderrOk = noFrames(actual.stderr) === noFrames(expected.stderr);
  } else {
    stderrOk = Buffer.compare(actual.stderr, expected.stderr) === 0;
  }
  if (!stderrOk) {
    problems.push(`stderr (${meta.stderr ?? 'exact'})\n--- expected ---\n${expected.stderr}\n--- actual ---\n${actual.stderr}`);
  }
  for (const p of problems) console.error(`${name} [${label}]: ${p}`);
  if (problems.length) process.exitCode = 1;
  return problems.length === 0;
}

let ran = 0;
for (const name of listCases()) {
  const dir = join(fixturesDir, name);
  const meta = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8'));
  const host = runHost(dir, meta);
  if (mode === 'record') {
    writeFileSync(join(dir, 'stdout.bin'), host.stdout);
    // An error-line case keeps only that line: stacks name machine paths.
    let stderr = host.stderr;
    if (meta.stderr === 'error-line') stderr = `${errorLine(host.stderr)}\n`;
    else if (meta.stderr === 'no-frames') stderr = noFrames(host.stderr);
    writeFileSync(join(dir, 'stderr.bin'), stderr);
    writeFileSync(join(dir, 'status.txt'), `${host.status}\n`);
    console.log(`recorded ${name}: status=${host.status} out=${host.stdout.length}B err=${host.stderr.length}B`);
    ran++;
    continue;
  }
  const expected = {
    status: Number(readFileSync(join(dir, 'status.txt'), 'utf8').trim()),
    stdout: readFileSync(join(dir, 'stdout.bin')),
    stderr: readFileSync(join(dir, 'stderr.bin')),
  };
  let ok = compare(name, 'host', host, expected, meta);
  if (meta.kernel === false) {
    console.log(`skip ${name} [kernel]: ${meta.kernelReason ?? 'kernel: false'}`);
  } else {
    ok = compare(name, 'kernel', await runKernel(dir, meta), expected, meta) && ok;
  }
  if (ok) console.log(`ok ${name}`);
  ran++;
}

if (ran === 0) {
  console.error('no cases');
  process.exit(2);
}
if (process.exitCode) process.exit(process.exitCode);
console.log(`jsh ${mode}: ${ran} case(s)`);
