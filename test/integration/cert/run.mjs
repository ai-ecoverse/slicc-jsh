// Requires `npm run build` so dist/ exists before packageFiles() can install slicc-jsh into the kernel.
// Differential cert: same files + argv on Node 22.22.0 (host) vs slicc-jsh in slicc-kernel.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '@ai-ecoverse/slicc-kernel/node';
import { packageFiles } from '../helpers.mjs';
import { cases } from './cases.mjs';

const certDir = dirname(fileURLToPath(import.meta.url));
// Host cwd must sit outside this repo: the package root is "type":"module", and
// Node would otherwise treat fixture .js files as ESM when walking up for package.json.
const HOST_ROOT = join('/tmp', 'slicc-jsh-cert-host');
const OUT_JSON = join(certDir, 'last-diff.json');
const TIMEOUT_MS = 20_000;

const argvFilter = process.argv.slice(2);
const certOnly = process.env.CERT_ONLY;
const onlyNames = certOnly ? [certOnly] : argvFilter;
const list = cases.filter((c) => !onlyNames.length || onlyNames.includes(c.name));

if (onlyNames.length && list.length === 0) {
  console.error(`no cases matched filter: ${onlyNames.join(', ')}`);
  process.exit(2);
}

/** M1-gap cases may differ until shims are defined; accept clear not-supported output from the shim. */
function m1GapShimAccepts(shim) {
  const out = `${shim.stdout ?? ''}${shim.stderr ?? ''}`.toLowerCase();
  return (
    out.includes('not supported') ||
    out.includes('err_not_supported') ||
    out.includes("isn't supported") ||
    out.includes('not a function') || // fetch stub before global install
    out.includes('is not defined')
  );
}

function exactMatch(same) {
  return same.status && same.stdout && same.stderr;
}

function casePasses(c, same, shim) {
  if (exactMatch(same)) return true;
  if (c.m1gap) return m1GapShimAccepts(shim);
  return false;
}

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

rmSync(HOST_ROOT, { recursive: true, force: true });
mkdirSync(HOST_ROOT, { recursive: true });

const k = await createNodeKernel();
const jshBase = '/node_modules/@ai-ecoverse/slicc-jsh';
for (const [rel, data] of packageFiles()) {
  await k.writeFile(`${jshBase}/${rel}`, data);
}

const results = [];
let sameCount = 0;
let diffCount = 0;
let failed = 0;

for (const c of list) {
  const hd = join(HOST_ROOT, c.name);
  mkdirSync(hd, { recursive: true });
  const kd = `/os/${c.name}`;

  await k.run(['node', '-e', `require('fs').mkdirSync(${JSON.stringify(kd)}, {recursive:true})`], {
    cwd: '/',
  });

  // Force CJS interpretation for host Node; mirror into the kernel so readdir('.') matches.
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

  const hostRaw = runNode22(c.argv, {
    cwd: hd,
    stdin: c.stdin,
    env: c.env,
  });
  const real = realpathSync(hd);
  const norm = (s) => {
    let out = s
      .split(real)
      .join(kd)
      .split(hd)
      .join(kd)
      // Node circular-dep warning is noisy and version-dependent; ignore for cert.
      .replace(/^\(node:\d+\) Warning:.*\n(?:\(Use `node --trace-warnings[\s\S]*?\n)?/gm, '');
    // Keep user frames + trailer; drop host-only node:internal CJS loader frames.
    if (out.includes('\nNode.js v') || out.includes('node:internal/modules/cjs/loader')) {
      const lines = out.split('\n');
      const kept = [];
      for (const line of lines) {
        if (line.includes('node:internal/') && !line.includes('[eval]')) continue;
        if (line.includes('at ModuleJob.') || line.includes('at async onImport.')) continue;
        if (line.includes('at wrapSafe ') || line.includes('at Module._compile')) continue;
        if (line.includes('at Object..js ') || line.includes('at Module.load')) continue;
        if (line.includes('at Function._load') || line.includes('at TracingChannel')) continue;
        if (line.includes('at wrapModuleLoad') || line.includes('at Module.require')) continue;
        if (line.includes('at require (node:internal')) continue;
        if (line.includes('at runScriptInThisContext') || line.includes('at node:internal/process/execution')) continue;
        if (line.includes('at [eval]-wrapper') || line.includes('at runScriptInContext')) continue;
        if (line.includes('at evalFunction') || line.includes('at runInContextFunction')) continue;
        if (line.includes('at executeUserEntryPoint') || line.includes('at runEntryOfEntry')) continue;
        kept.push(line);
      }
      out = kept.join('\n');
    }
    return out;
  };
  const host = {
    status: hostRaw.status,
    stdout: norm(hostRaw.stdout),
    stderr: norm(hostRaw.stderr),
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

  const same = {
    status: host.status === shim.status,
    stdout: host.stdout === shim.stdout,
    stderr: host.stderr === shim.stderr,
  };
  const passes = casePasses(c, same, shim);
  const exact = exactMatch(same);

  if (exact) sameCount++;
  else diffCount++;

  if (!passes) failed++;

  results.push({
    name: c.name,
    m1gap: !!c.m1gap,
    same,
    pass: passes,
    host,
    shim: { status: shim.status, stdout: shim.stdout, stderr: shim.stderr, ms: shim.ms },
  });

  let tag;
  if (exact) tag = 'SAME';
  else if (passes && c.m1gap) tag = `M1GAP-OK(${Object.entries(same).filter(([, v]) => !v).map(([k2]) => k2).join(',')})`;
  else tag = `DIFF(${Object.entries(same).filter(([, v]) => !v).map(([k2]) => k2).join(',')})`;

  console.log(`# ${c.m1gap ? 'M1-GAP ' : ''}${tag} ${c.name} (${shim.ms} ms)`);
}

writeFileSync(OUT_JSON, JSON.stringify(results, null, 1));

try {
  k.terminate();
} catch {}

console.log(`\ncert: ${list.length} case(s), SAME=${sameCount}, DIFF=${diffCount}, failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
