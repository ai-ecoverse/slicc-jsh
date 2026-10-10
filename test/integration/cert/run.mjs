/**
 * Differential cert harness aligned with thr_hb2dpaitvt:
 * - load kernel from a plain dist path (NOT node_modules)
 * - compare host/shim with minimal normalisation (paths, pids, timings only)
 * - run cases.mjs / cases2.mjs / cases3.mjs / cases4.mjs
 *
 * Usage:
 *   node test/integration/cert/run.mjs              # all suites
 *   CASES=./cases.mjs node test/integration/cert/run.mjs
 *   node test/integration/cert/run.mjs case-name
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { packageFiles } from '../helpers.mjs';

const certDir = dirname(fileURLToPath(import.meta.url));
const root = join(certDir, '../../..');
const TIMEOUT_MS = 20_000;

const casesPath = process.env.CASES
  ? join(certDir, process.env.CASES.replace(/^\.\//, ''))
  : null;
const suites = casesPath
  ? [{ name: relative(certDir, casesPath), path: casesPath }]
  : [
      { name: 'cases.mjs', path: join(certDir, 'cases.mjs') },
      { name: 'cases2.mjs', path: join(certDir, 'cases2.mjs') },
      { name: 'cases3.mjs', path: join(certDir, 'cases3.mjs') },
      { name: 'cases4.mjs', path: join(certDir, 'cases4.mjs') },
    ];

const only = process.argv.slice(2);

// Copy kernel dist out of node_modules so frame paths don't contain that prefix.
const kernelPkg = join(root, 'node_modules/@ai-ecoverse/slicc-kernel');
const kernelCopy = mkdtempSync(join(tmpdir(), 'slicc-kernel-dist-'));
cpSync(join(kernelPkg, 'dist'), join(kernelCopy, 'dist'), { recursive: true });
const kernelEntry = join(kernelCopy, 'dist/node.js');
const { createNodeKernel } = await import(pathToFileURL(kernelEntry).href);

// Pad the host path so Node's util.inspect wraps requireStack the same way on
// Linux (/tmp/…) as on macOS (/private/tmp/…): short /tmp paths stay one line
// at breakLength 80 and DIFF against our multiline MODULE_NOT_FOUND props.
const HOST_ROOT = join('/tmp', 'private', 'slicc-jsh-cert-host');
rmSync(HOST_ROOT, { recursive: true, force: true });
mkdirSync(HOST_ROOT, { recursive: true });

const k = await createNodeKernel();
const jshBase = '/node_modules/@ai-ecoverse/slicc-jsh';
for (const [rel, data] of packageFiles()) {
  await k.writeFile(`${jshBase}/${rel}`, data);
}

function m1GapShimAccepts(shim) {
  const out = `${shim.stdout ?? ''}${shim.stderr ?? ''}`.toLowerCase();
  return out.includes('not supported') || out.includes('err_not_supported');
}

/** Harmless DIFFs we ship with (listed in the 0.1.0-4 cert report). */
const ACCEPTED_DIFF = new Set([
  // macOS host often EACCES on /dev/stdin while the shim reads the pipe (Node-like).
  'c-stdin-readFileSync0',
]);

function runNode22(argv, { cwd, stdin, env, timeoutMs = TIMEOUT_MS } = {}) {
  const result = spawnSync('npx', ['-y', 'node@22.22.0', ...argv], {
    cwd,
    input: stdin ?? '',
    env: { ...process.env, npm_config_yes: 'true', ...(env ?? {}) },
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? (result.signal ? `signal ${result.signal}` : 1),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Mask pids, paths, timings, and Node machinery frames (per 0.1.0-4 bar). */
function normalize(s, real, hd, kd) {
  const masked = s
    .split(real)
    .join(kd)
    .split(hd)
    .join(kd)
    .replace(/\(node:\d+\)/g, '(node:PID)')
    .replace(/\bpid:\s*\d+/gi, 'pid: PID')
    .replace(/\b\d+(\.\d+)?\s*ms\b/g, 'Nms')
    .replace(/Date\.now\(\)-t>=\d+/g, 'Date.now()-t>=N');
  const lines = masked.split('\n');
  const out = [];
  for (const line of lines) {
    if (
      /^\s*at\s.+\(node:[^)]+\)/.test(line) ||
      /^\s*at\s+node:/.test(line) ||
      /^\s*at\s+\[eval\]-wrapper:/.test(line)
    ) {
      // If the removed frame carried the props `{`, keep it on the previous frame.
      if (/\{\s*$/.test(line) && out.length) {
        const prev = out[out.length - 1];
        if (!/\{\s*$/.test(prev)) out[out.length - 1] = `${prev} {`;
      }
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

const summary = [];

for (const suite of suites) {
  const { cases } = await import(pathToFileURL(suite.path).href);
  const list = cases.filter((c) => !only.length || only.includes(c.name));
  const results = [];
  let sameCount = 0;
  let diffCount = 0;
  let failed = 0;

  for (const c of list) {
    const hd = join(HOST_ROOT, suite.name.replace(/\.mjs$/, ''), c.name);
    mkdirSync(hd, { recursive: true });
    const kd = `/os/${c.name}`;

    await k.run(['node', '-e', `require('fs').mkdirSync(${JSON.stringify(kd)},{recursive:true})`], {
      cwd: '/',
    });

    if (!Object.prototype.hasOwnProperty.call(c.files ?? {}, 'package.json')) {
      const pkg = '{"type":"commonjs"}\n';
      writeFileSync(join(hd, 'package.json'), pkg);
      await k.writeFile(`${kd}/package.json`, new TextEncoder().encode(pkg));
    }
    for (const [rel, content] of Object.entries(c.files ?? {})) {
      mkdirSync(dirname(join(hd, rel)), { recursive: true });
      writeFileSync(join(hd, rel), content);
      await k.writeFile(`${kd}/${rel}`, new TextEncoder().encode(content));
    }

    const hostRaw = runNode22(c.argv, { cwd: hd, stdin: c.stdin, env: c.env });
    const real = realpathSync(hd);
    const host = {
      status: hostRaw.status,
      stdout: normalize(hostRaw.stdout, real, hd, kd),
      stderr: normalize(hostRaw.stderr, real, hd, kd),
    };

    const t0 = Date.now();
    let shim;
    try {
      shim = await Promise.race([
        k.run(['node', ...c.argv], {
          cwd: kd,
          env: c.env ?? {},
          ...(c.stdin !== undefined ? { stdin: c.stdin } : {}),
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT 20s')), TIMEOUT_MS)),
      ]);
    } catch (e) {
      shim = { status: String(e.message), stdout: '', stderr: '' };
    }
    shim.ms = Date.now() - t0;
    shim.stdout = normalize(shim.stdout ?? '', real, hd, kd);
    shim.stderr = normalize(shim.stderr ?? '', real, hd, kd);

    const same = {
      status: host.status === shim.status,
      stdout: host.stdout === shim.stdout,
      stderr: host.stderr === shim.stderr,
    };
    const exact = same.status && same.stdout && same.stderr;
    const accepted = ACCEPTED_DIFF.has(c.name);
    const pass = exact || (c.m1gap && m1GapShimAccepts(shim)) || accepted;
    if (exact) sameCount++;
    else diffCount++;
    if (!pass) failed++;

    results.push({
      name: c.name,
      m1gap: !!c.m1gap,
      accepted,
      same,
      pass,
      host,
      shim: { status: shim.status, stdout: shim.stdout, stderr: shim.stderr, ms: shim.ms },
    });

    let tag;
    if (exact) tag = 'SAME';
    else if (pass && c.m1gap) {
      tag = `M1GAP-OK(${Object.entries(same)
        .filter(([, v]) => !v)
        .map(([k2]) => k2)
        .join(',')})`;
    } else if (pass && accepted) {
      tag = `ACCEPT(${Object.entries(same)
        .filter(([, v]) => !v)
        .map(([k2]) => k2)
        .join(',')})`;
    } else {
      tag = `DIFF(${Object.entries(same)
        .filter(([, v]) => !v)
        .map(([k2]) => k2)
        .join(',')})`;
    }
    console.log(`# ${c.m1gap ? 'M1-GAP ' : ''}${tag} ${c.name} (${shim.ms} ms)`);
  }

  const outFile = join(certDir, `last-diff-${suite.name.replace(/\.mjs$/, '')}.json`);
  writeFileSync(outFile, JSON.stringify(results, null, 1));
  console.log(`\ncert[${suite.name}]: ${list.length} case(s), SAME=${sameCount}, DIFF=${diffCount}, failed=${failed}`);
  summary.push({ suite: suite.name, total: list.length, sameCount, diffCount, failed });
}

try {
  k.terminate();
} catch {
  /* ignore */
}
try {
  rmSync(kernelCopy, { recursive: true, force: true });
} catch {
  /* ignore */
}

writeFileSync(join(certDir, 'last-diff.json'), JSON.stringify(summary, null, 2));
const totalFailed = summary.reduce((n, s) => n + s.failed, 0);
if (totalFailed > 0) {
  for (const suite of summary) {
    const file = join(certDir, `last-diff-${suite.suite.replace(/\.mjs$/, '')}.json`);
    try {
      const rows = JSON.parse(readFileSync(file, 'utf8'));
      for (const r of rows) {
        if (r.pass) continue;
        console.error(`\n---- FAIL ${suite.suite} ${r.name} ----`);
        console.error('same', JSON.stringify(r.same));
        if (!r.same.stdout) {
          console.error('HOST stdout:', JSON.stringify(r.host.stdout));
          console.error('SHIM stdout:', JSON.stringify(r.shim.stdout));
        }
        if (!r.same.stderr) {
          console.error('HOST stderr:', JSON.stringify(r.host.stderr));
          console.error('SHIM stderr:', JSON.stringify(r.shim.stderr));
        }
      }
    } catch {
      /* ignore */
    }
  }
}
process.exit(totalFailed > 0 ? 1 : 0);
