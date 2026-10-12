#!/usr/bin/env node
/**
 * Runs every case in test/compare/cases on four systems and records what
 * each one printed:
 *
 *   six    SLICC v6's JS realm, run headless from a slicc checkout under its
 *          own vitest setup (see six/driver.test.ts)
 *   seven  the kernel `jsh` (this repo's dist/) on slicc-kernel's Node entry,
 *          with wasm bash and coreutils installed so `exec(cmd)` has a shell
 *   jsh    the host `jsh` (dist/host/jsh.mjs) on real Node 22.22.0
 *   node   the same case as a plain Node 22.22.0 program (see "node" below)
 *
 * test/compare/cases/<case>/case.json:
 *   area, description   what the case pins
 *   corpus              feature keys from corpus.mjs this case stands for
 *   entry               the script, relative to the case (default main.jsh)
 *   args, env, stdin    as for the jsh golden harness
 *   node                how the plain-Node run gets its program:
 *                       "mjs" (default) the body as an ES module, with
 *                         require/__filename/__dirname/module/exports
 *                         defined on its first line;
 *                       "cjs" the body verbatim as a CommonJS file (top-level
 *                         `return` works, top-level `await` doesn't);
 *                       false  no plain-Node run.
 *                       A node.mjs or node.cjs file in the case wins.
 *   skip                { "<system>": "reason" } to leave a system out
 *
 * Output: test/compare/results/<case>/<system>.json ({ status, stdout,
 * stderr }), normalised so paths and ports read the same everywhere
 * ($CASE, $NODE, $HTTP), then results/summary.json and results/SUMMARY.md.
 *
 * Usage: node test/compare/run.mjs [--systems six,seven,jsh,node]
 *          [--six-root <slicc checkout>] [case…]
 *        node test/compare/run.mjs --summary   (only rewrite SUMMARY.md)
 * The slicc checkout defaults to $JSH_COMPARE_SIX_ROOT, then
 * ~/Developer/ai-ecoverse/slicc. It needs `npm ci` done.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  cpSync,
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
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeKernel, nodeTransport } from '@ai-ecoverse/slicc-kernel/node';
import { WebSocketServer } from 'ws';
import { packageFiles } from '../integration/helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const casesDir = join(here, 'cases');
const resultsDir = join(here, 'results');
const cacheDir = join(root, 'node_modules/.cache/jsh-compare');
const hostJsh = join(root, 'dist/host/jsh.mjs');
const ALL = ['six', 'seven', 'jsh', 'node'];
const NODE_VERSION = '22.22.0';
const KERNEL_PACKAGES = ['@ai-ecoverse/wasm-bash@5.3.0-17', '@ai-ecoverse/wasm-coreutils@9.12.0-5'];
const CASE_TIMEOUT_MS = 30_000;
const SIX_CASE_ROOT = '/workspace/skills/jshc';
const SEVEN_CASE_ROOT = '/os';

// --- arguments -------------------------------------------------------------

const argv = process.argv.slice(2);
let systems = ALL;
let sixRoot = process.env.JSH_COMPARE_SIX_ROOT ?? join(homedir(), 'Developer/ai-ecoverse/slicc');
const only = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--systems') systems = argv[++i].split(',').filter(Boolean);
  else if (argv[i] === '--summary') systems = [];
  else if (argv[i] === '--six-root') sixRoot = argv[++i];
  else only.push(argv[i]);
}
for (const s of systems) {
  if (!ALL.includes(s)) {
    console.error(`unknown system ${s}`);
    process.exit(2);
  }
}
if (!existsSync(hostJsh)) {
  console.error('compare: dist/ is missing (npm run build)');
  process.exit(2);
}

// --- cases -----------------------------------------------------------------

function listCases() {
  return readdirSync(casesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => (only.length ? only.includes(name) : true))
    .sort();
}

function caseFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      if (current === dir && name === 'case.json') continue;
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push({ rel: relative(dir, path).replaceAll('\\', '/'), data: readFileSync(path) });
    }
  };
  walk(dir);
  return out;
}

function loadCase(name) {
  const dir = join(casesDir, name);
  const meta = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8'));
  return {
    name,
    dir,
    meta: { entry: 'main.jsh', args: [], env: {}, node: 'mjs', skip: {}, corpus: [], ...meta },
    files: caseFiles(dir),
  };
}

// --- local HTTP / WebSocket server -----------------------------------------

function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, type, body, headers = {}) => {
      res.writeHead(status, { 'content-type': type, 'x-compare': 'yes', ...headers });
      res.end(body);
    };
    if (url.pathname === '/json') return send(200, 'application/json', '{"ok":true,"n":1}');
    if (url.pathname === '/text') return send(200, 'text/plain; charset=utf-8', 'hello é\n');
    if (url.pathname === '/missing') return send(404, 'application/json', '{"error":"nope"}');
    if (url.pathname === '/fail') return send(500, 'text/plain', 'server error');
    if (url.pathname === '/redirect') return send(302, 'text/plain', '', { location: '/json' });
    if (url.pathname === '/mod.mjs') {
      return send(200, 'text/javascript', 'export default 42;\nexport const answer = "remote";\n');
    }
    if (url.pathname === '/slow') {
      return setTimeout(() => send(200, 'text/plain', 'slow'), 300);
    }
    if (url.pathname === '/bytes') return send(200, 'application/octet-stream', Buffer.from([0, 1, 254, 255]));
    if (url.pathname === '/echo') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        send(
          200,
          'application/json',
          JSON.stringify({
            method: req.method,
            path: url.pathname + url.search,
            contentType: req.headers['content-type'] ?? null,
            auth: req.headers.authorization ?? null,
            custom: req.headers['x-custom'] ?? null,
            body,
          })
        );
      });
      return undefined;
    }
    return send(404, 'text/plain', 'no route');
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => {
    socket.on('message', (data, isBinary) => socket.send(isBinary ? data : `echo:${data}`));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, wss, port: server.address().port }));
  });
}

// --- normalisation ---------------------------------------------------------

function normalise(text, { caseRoots, port }) {
  let out = text;
  for (const r of caseRoots) if (r) out = out.split(r).join('$CASE');
  if (node22) out = out.split(node22).join('$NODE');
  out = out.split(`127.0.0.1:${port}`).join('$HTTP').split(`host.slicc.internal:${port}`).join('$HTTP');
  out = out.split(root.replace(/\/$/, '')).join('$REPO');
  out = out.replace(/\(node:\d+\)/g, '(node:PID)').replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, 'data:text/javascript;base64,…');
  // Keep stack frames in the case's own files; engine-internal frames (and
  // their line numbers, which move with every build) collapse to one line.
  const lines = [];
  for (const line of out.split('\n')) {
    const internal = /^\s+at /.test(line) && !line.includes('$CASE');
    if (internal && lines.at(-1) === '    at <internal>') continue;
    if (internal) lines.push('    at <internal>');
    else lines.push(line.length > 2000 ? `${line.slice(0, 300)}…[${line.length} chars]` : line);
  }
  return lines.join('\n');
}

// --- node / jsh ------------------------------------------------------------

let node22;
function resolveNode22() {
  const r = spawnSync('npx', ['-y', `node@${NODE_VERSION}`, '-p', 'process.execPath'], {
    encoding: 'utf8',
    env: { ...process.env, npm_config_yes: 'true' },
  });
  if (r.status !== 0) throw new Error(`cannot get node@${NODE_VERSION}: ${r.stderr}`);
  return r.stdout.trim();
}

function hostEnv(extra) {
  const env = { ...process.env };
  for (const k of ['FORCE_COLOR', 'NO_COLOR', 'NODE_OPTIONS', 'npm_config_yes']) delete env[k];
  return { ...env, ...extra };
}

function plainProgram(c, work) {
  for (const f of ['node.mjs', 'node.cjs']) if (existsSync(join(work, f))) return f;
  if (c.meta.node === false) return null;
  const src = readFileSync(join(work, c.meta.entry), 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/^#!.*/, '');
  if (c.meta.node === 'cjs') {
    const file = c.meta.entry.replace(/\.jsh$/, '.plain.cjs');
    writeFileSync(join(work, file), src);
    return file;
  }
  const file = c.meta.entry.replace(/\.jsh$/, '.plain.mjs');
  // One line, so line numbers stay the script's own.
  const prelude =
    "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; " +
    'const require = __cr(import.meta.url), __filename = __fu(import.meta.url), ' +
    "__dirname = __filename.slice(0, __filename.lastIndexOf('/')), module = { exports: {} }, exports = module.exports;";
  writeFileSync(join(work, file), prelude + src);
  return file;
}

function spawnCollect(cmd, args, { cwd, env, stdin }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CASE_TIMEOUT_MS);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '');
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        status: timedOut ? 'timeout' : (code ?? `signal ${signal}`),
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

async function runHost(c, system, http) {
  const work = realpathSync(mkdtempSync(join(tmpdir(), `jsh-compare-${system}-`)));
  try {
    for (const { rel, data } of c.files) {
      mkdirSync(dirname(join(work, rel)), { recursive: true });
      writeFileSync(join(work, rel), data);
    }
    let args;
    if (system === 'jsh') args = [hostJsh, c.meta.entry, ...c.meta.args];
    else {
      const file = plainProgram(c, work);
      if (!file) return null;
      args = [file, ...c.meta.args];
    }
    const env = hostEnv({ COMPARE_HTTP: `http://127.0.0.1:${http.port}`, ...c.meta.env });
    const r = await spawnCollect(node22, args, { cwd: work, env, stdin: c.meta.stdin });
    const caseRoots = [work, work.replace(/^\/private/, '')];
    return { ...r, stdout: normalise(r.stdout, { caseRoots, port: http.port }), stderr: normalise(r.stderr, { caseRoots, port: http.port }) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- seven -----------------------------------------------------------------

function kernelPackages() {
  const out = [];
  for (const spec of KERNEL_PACKAGES) {
    const name = spec.slice(0, spec.lastIndexOf('@'));
    const dir = join(cacheDir, spec.replace('/', '__'));
    if (!existsSync(join(dir, 'package/package.json'))) {
      mkdirSync(dir, { recursive: true });
      const pack = spawnSync('npm', ['pack', spec, '--pack-destination', dir, '--silent'], { encoding: 'utf8' });
      if (pack.status !== 0) throw new Error(`npm pack ${spec}: ${pack.stderr}`);
      const tgz = join(dir, pack.stdout.trim().split('\n').pop());
      const untar = spawnSync('tar', ['-xzf', tgz, '-C', dir]);
      if (untar.status !== 0) throw new Error(`tar ${tgz} failed`);
      rmSync(tgz);
    }
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else out.push([`/node_modules/${name}/${relative(join(dir, 'package'), p)}`, readFileSync(p)]);
      }
    };
    walk(join(dir, 'package'));
  }
  return out;
}

let kernelExtra;
let jshFiles;
async function runSeven(c, http) {
  kernelExtra ??= kernelPackages();
  jshFiles ??= packageFiles();
  const kernel = await createNodeKernel({ network: { transport: nodeTransport() } });
  try {
    for (const [rel, data] of jshFiles) {
      await kernel.writeFile(`/node_modules/@ai-ecoverse/slicc-jsh/${rel}`, data);
    }
    for (const [path, data] of kernelExtra) await kernel.writeFile(path, data);
    for (const { rel, data } of c.files) await kernel.writeFile(`${SEVEN_CASE_ROOT}/${rel}`, data);
    // Partial output survives a timeout.
    const live = { stdout: '', stderr: '' };
    const work = kernel.run(['jsh', c.meta.entry, ...c.meta.args], {
      cwd: SEVEN_CASE_ROOT,
      // jsh's fetch goes straight to the transport, so 127.0.0.1 is the
      // host's loopback here (the kernel's own sockets are another network).
      env: { COMPARE_HTTP: `http://127.0.0.1:${http.port}`, ...c.meta.env },
      onStdout: (t) => {
        live.stdout += t;
      },
      onStderr: (t) => {
        live.stderr += t;
      },
      ...(c.meta.stdin !== undefined ? { stdin: c.meta.stdin } : {}),
    });
    let timer;
    const r = await Promise.race([
      work,
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ status: 'timeout', stdout: live.stdout, stderr: `${live.stderr}[compare: kernel timeout]\n` }),
          CASE_TIMEOUT_MS
        );
      }),
    ]);
    clearTimeout(timer);
    const caseRoots = [SEVEN_CASE_ROOT];
    return {
      status: r.status,
      stdout: normalise(String(r.stdout), { caseRoots, port: http.port }),
      stderr: normalise(String(r.stderr), { caseRoots, port: http.port }),
    };
  } finally {
    kernel.terminate();
  }
}

// --- six -------------------------------------------------------------------

async function runSix(cases, http) {
  if (!existsSync(join(sixRoot, 'packages/webapp/src/kernel/realm/js-realm-shared.ts'))) {
    throw new Error(`no slicc checkout at ${sixRoot} (--six-root)`);
  }
  const driverDir = join(sixRoot, 'packages/webapp/tests/__jsh_compare__');
  const scratch = mkdtempSync(join(tmpdir(), 'jsh-compare-six-'));
  const jobsFile = join(scratch, 'jobs.json');
  const outFile = join(scratch, 'out.json');
  const jobs = cases
    .filter((c) => !c.meta.skip.six)
    .map((c) => ({
      name: c.name,
      root: SIX_CASE_ROOT,
      entry: c.meta.entry,
      files: c.files.map(({ rel, data }) => ({ rel, b64: data.toString('base64') })),
      args: c.meta.args,
      env: { COMPARE_HTTP: `http://127.0.0.1:${http.port}`, ...c.meta.env },
      ...(c.meta.stdin !== undefined ? { stdin: Buffer.from(c.meta.stdin).toString('base64') } : {}),
      timeoutMs: CASE_TIMEOUT_MS,
    }));
  writeFileSync(jobsFile, JSON.stringify(jobs));
  mkdirSync(driverDir, { recursive: true });
  cpSync(join(here, 'six/driver.test.ts'), join(driverDir, 'driver.test.ts'));
  try {
    const child = spawn(
      'npx',
      ['vitest', 'run', '--project', 'webapp', 'packages/webapp/tests/__jsh_compare__/driver.test.ts'],
      {
        cwd: sixRoot,
        env: { ...hostEnv({}), JSH_COMPARE_JOBS: jobsFile, JSH_COMPARE_OUT: outFile },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const log = [];
    child.stdout.on('data', (d) => log.push(d));
    child.stderr.on('data', (d) => log.push(d));
    const [code] = await once(child, 'close');
    if (!existsSync(outFile)) {
      throw new Error(`six driver failed (${code}):\n${Buffer.concat(log).toString('utf8').slice(-4000)}`);
    }
    const raw = JSON.parse(readFileSync(outFile, 'utf8'));
    const out = {};
    for (const [name, r] of Object.entries(raw)) {
      const caseRoots = [SIX_CASE_ROOT];
      out[name] = {
        status: r.status,
        stdout: normalise(Buffer.from(r.stdout, 'base64').toString('utf8'), { caseRoots, port: http.port }),
        stderr: normalise(Buffer.from(r.stderr, 'base64').toString('utf8'), { caseRoots, port: http.port }),
      };
    }
    return out;
  } finally {
    rmSync(driverDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

function sixCommit() {
  const r = spawnSync('git', ['-C', sixRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  const v = JSON.parse(readFileSync(join(sixRoot, 'package.json'), 'utf8')).version;
  return `${v} (${r.stdout.trim()})`;
}

// --- summary ---------------------------------------------------------------

/** Status, stdout and stderr without stack frames or Node's source excerpt. */
function signature(r) {
  if (!r) return null;
  const stderr = r.stderr
    .split('\n')
    .filter((l) => !/^\s+at /.test(l) && !/^Node\.js v\d/.test(l))
    .join('\n')
    .trim();
  return JSON.stringify([r.status, r.stdoutSha256 ?? r.stdout, stderr]);
}

function readResult(name, system) {
  const p = join(resultsDir, name, `${system}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

function writeSummary() {
  const rows = [];
  for (const name of readdirSync(casesDir).sort()) {
    if (!existsSync(join(casesDir, name, 'case.json'))) continue;
    const c = loadCase(name);
    const r = Object.fromEntries(ALL.map((s) => [s, readResult(name, s)]));
    const sig = Object.fromEntries(ALL.map((s) => [s, signature(r[s])]));
    const ref = sig.jsh;
    const agree = (s) => (sig[s] === null ? '–' : sig[s] === ref ? '=' : '≠');
    let auto;
    if (sig.six === ref && sig.seven === ref) auto = 'same';
    else if (sig.seven === ref) auto = 'six≠node';
    else if (sig.six === ref) auto = 'seven≠node';
    else if (sig.six === sig.seven) auto = 'six=seven≠node';
    else auto = 'all differ';
    rows.push({
      name,
      area: c.meta.area ?? '',
      description: c.meta.description ?? '',
      corpus: c.meta.corpus,
      status: Object.fromEntries(ALL.map((s) => [s, r[s]?.status ?? null])),
      six: agree('six'),
      seven: agree('seven'),
      node: sig.node === null ? '–' : sig.node === ref ? '=' : '≠',
      auto,
    });
  }
  const meta = existsSync(join(resultsDir, 'meta.json')) ? JSON.parse(readFileSync(join(resultsDir, 'meta.json'), 'utf8')) : {};
  writeFileSync(join(resultsDir, 'summary.json'), `${JSON.stringify({ meta, rows }, null, 2)}\n`);
  const lines = [
    '# Recorded comparison',
    '',
    'Generated by `node test/compare/run.mjs`; see [the gap report](../../../docs/compare/seven-six-node.md).',
    '',
    `six: ${meta.six ?? '?'}; seven: slicc-jsh ${meta.jsh ?? '?'} on slicc-kernel ${meta.kernel ?? '?'}; node: ${meta.node ?? '?'}.`,
    '',
    'Columns compare each system with the host `jsh` on Node (the reference): `=` same status, stdout and',
    'stderr (stack frames ignored), `≠` different, `–` not run. `node` is the plain Node program.',
    '',
    '| case | area | six | seven | node | auto | status six/seven/jsh/node |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const row of rows) {
    const st = ALL.map((s) => row.status[s] ?? '–').join(' / ');
    lines.push(`| [${row.name}](${row.name}) | ${row.area} | ${row.six} | ${row.seven} | ${row.node} | ${row.auto} | ${st} |`);
  }
  writeFileSync(join(resultsDir, 'SUMMARY.md'), `${lines.join('\n')}\n`);
}

// --- main ------------------------------------------------------------------

const names = listCases();
if (!names.length) {
  console.error('no cases');
  process.exit(2);
}
const cases = names.map(loadCase);
const http = await startServer();
mkdirSync(resultsDir, { recursive: true });
const BIG = 64 * 1024;
const write = (name, system, result) => {
  mkdirSync(join(resultsDir, name), { recursive: true });
  // Big outputs are kept as a digest so the recording stays reviewable.
  if (result.stdout.length > BIG) {
    const { stdout, ...rest } = result;
    result = {
      ...rest,
      stdout: `${stdout.slice(0, 300)}…`,
      stdoutChars: stdout.length,
      stdoutSha256: createHash('sha256').update(stdout).digest('hex'),
    };
  }
  writeFileSync(join(resultsDir, name, `${system}.json`), `${JSON.stringify(result, null, 2)}\n`);
};

try {
  const meta = existsSync(join(resultsDir, 'meta.json')) ? JSON.parse(readFileSync(join(resultsDir, 'meta.json'), 'utf8')) : {};
  if (systems.includes('jsh') || systems.includes('node')) {
    node22 = resolveNode22();
    meta.node = NODE_VERSION;
  } else {
    try {
      node22 = resolveNode22();
    } catch {
      /* normalisation only */
    }
  }
  meta.jsh = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  meta.kernel = JSON.parse(
    readFileSync(join(root, 'node_modules/@ai-ecoverse/slicc-kernel/package.json'), 'utf8')
  ).version;
  meta.kernelPackages = KERNEL_PACKAGES;
  if (systems.includes('six')) meta.six = sixCommit();
  writeFileSync(join(resultsDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);

  for (const system of ['jsh', 'node', 'seven']) {
    if (!systems.includes(system)) continue;
    for (const c of cases) {
      if (c.meta.skip[system]) {
        write(c.name, system, { skipped: c.meta.skip[system], status: null, stdout: '', stderr: '' });
        continue;
      }
      const r = system === 'seven' ? await runSeven(c, http) : await runHost(c, system, http);
      if (r) write(c.name, system, r);
      else rmSync(join(resultsDir, c.name, `${system}.json`), { force: true });
      console.log(`${system} ${c.name}: ${r ? r.status : 'n/a'}`);
    }
  }
  if (systems.includes('six')) {
    const six = await runSix(cases, http);
    for (const c of cases) {
      if (c.meta.skip.six) {
        write(c.name, 'six', { skipped: c.meta.skip.six, status: null, stdout: '', stderr: '' });
      } else if (six[c.name]) {
        write(c.name, 'six', six[c.name]);
        console.log(`six ${c.name}: ${six[c.name].status}`);
      }
    }
  }
  writeSummary();
} finally {
  http.wss.close();
  http.server.close();
  http.server.closeAllConnections?.();
}
process.exit(0);
