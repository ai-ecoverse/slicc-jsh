#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ARGV, NORMALIZE, ROWS, ROW_DIRS, SKIP, SKIP_CASES } from '../../test/cert-review/fixtures.mjs';
import { npmFlags, readJson, root, sh, walk } from './lib.mjs';

const { values } = parseArgs({
  options: {
    work: { type: 'string' },
    kernel: { type: 'string' },
    pkg: { type: 'string', default: 'new,prev' },
    only: { type: 'string', default: '' },
    user: { type: 'string', default: 'cone' },
    timeout: { type: 'string', default: '20000' },
    shard: { type: 'string', default: '1/1' },
    case: { type: 'string', default: '' },
  },
});
const work = resolve(values.work);
const stage = readJson(join(work, 'stage.json'));
const kernel = stage.kernels.find((k) => k.id === values.kernel || k.names.includes(values.kernel));
if (!kernel) throw new Error(`no staged kernel ${values.kernel}`);
if (kernel.id !== values.kernel) {
  console.log(`mfixtures: kernel ${values.kernel} is ${kernel.version}, the same as ${kernel.id}: nothing to run`);
  process.exit(0);
}
const NODE22 = process.env.NODE22;
if (!NODE22) throw new Error('mfixtures: $NODE22 must name host Node 22.22.0');
const CASE_MS = Number(values.timeout);
const [shardIx, shardOf] = (() => {
  const [i, n] = values.shard.split('/').map(Number);
  return [i - 1, n];
})();
const suffix = shardOf > 1 ? `-${shardIx + 1}` : '';
const out = join(work, 'fixtures', kernel.id);
mkdirSync(out, { recursive: true });
const base = stage.trees.base;

const fx = join(work, 'fx');
if (!existsSync(join(fx, '.staged'))) {
  rmSync(fx, { recursive: true, force: true });
  cpSync(join(root, 'test/fixtures/cert-review/fx'), fx, { recursive: true });
  for (const d of readdirSync(fx)) {
    if (existsSync(join(fx, d, 'package-lock.json')) && !d.includes('.')) sh('npm', ['ci', '--ignore-scripts', ...npmFlags], { cwd: join(fx, d) });
  }
  writeFileSync(join(fx, '.staged'), '');
}

const { createNodeKernel, nodeTransport } = await import(pathToFileURL(join(kernel.plain, 'dist/node.js')).href);

async function install(k, dir, name) {
  for (const f of walk(dir)) await k.writeFile(`/node_modules/${name}/${relative(dir, f).replaceAll('\\', '/')}`, readFileSync(f));
}

async function boot(pkgDir) {
  const k = await createNodeKernel({ users: 'enforce', network: { transport: nodeTransport() } });
  for (const u of ['cone', 'cone2']) await k.users.add({ name: u });
  for (const n of ['wasm-bash', 'wasm-coreutils']) await install(k, join(base, '@ai-ecoverse', n), `@ai-ecoverse/${n}`);
  await install(k, pkgDir, '@ai-ecoverse/slicc-jsh');
  return k;
}

const race = (p, ms) =>
  Promise.race([p, new Promise((res) => setTimeout(() => res({ status: 'TIMEOUT', stdout: '', stderr: '' }), ms))]);

async function krun(k, argv, opts, ms = CASE_MS) {
  let so = '';
  let se = '';
  const r = await race(
    k.run(argv, { ...opts, onStdout: (t) => (so += t), onStderr: (t) => (se += t) }).catch((e) => ({ status: `ERROR ${e.message}`, stdout: so, stderr: se })),
    ms
  );
  return r.status === 'TIMEOUT' ? { status: 'TIMEOUT', stdout: so, stderr: se } : r;
}

const hostJshCache = new Map();
function hostJsh(name) {
  if (hostJshCache.has(name)) return hostJshCache.get(name);
  const tgz = name === 'new' ? stage.published.tarball : stage.previous.tarball;
  const prefix = join(work, 'hostjsh', name);
  rmSync(prefix, { recursive: true, force: true });
  sh('npm', ['install', '-g', '--prefix', prefix, '--ignore-scripts', ...npmFlags, tgz]);
  const bin = mkdtempSync(join(work, 'hostbin-'));
  symlinkSync(NODE22, join(bin, 'node'));
  symlinkSync(join(prefix, 'bin/jsh'), join(bin, 'jsh'));
  hostJshCache.set(name, bin);
  return bin;
}

function modeOf(dir) {
  if (SKIP[dir]) return 'skip';
  if (ROW_DIRS.includes(dir)) return 'row';
  if (ARGV[dir]) return 'argv';
  if (dir === 'must') return 'must';
  if (dir === 'np6') return 'np';
  const files = readdirSync(join(fx, dir));
  if (files.some((f) => f.endsWith('.sh.mjs'))) return 'sh';
  if (files.some((f) => f.endsWith('.jsh'))) return 'jsh';
  return 'node';
}

function normaliser(...dirs) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(/private)?(${dirs.map(esc).join('|')})`, 'g');
  return (s) =>
    s
      .replace(re, '/M')
      .replace(/\(node:\d+\)/g, '(node:PID)')
      .replace(/\b\d{4,5}\b/g, 'PORT')
      .replace(/\r/g, '')
      .trim();
}

const tail = (e, n = 12) => (e ? `\n[stderr] ${e.trim().split('\n').slice(0, n).join(' | ')}` : '');

async function casesFor(dir, mode) {
  const here = join(fx, dir);
  if (mode === 'node') {
    const files = readdirSync(here).filter((f) => /\.(m?js|cjs)$/.test(f));
    if (existsSync(join(here, 'cjs'))) for (const f of readdirSync(join(here, 'cjs'))) if (f.endsWith('.js')) files.push(`cjs/${f}`);
    return files.sort().map((f) => ({ name: f, argv: ['node', f], host: [NODE22, f] }));
  }
  if (mode === 'argv') return ARGV[dir].map(([name, argv]) => ({ name, argv: ['node', ...argv], host: [NODE22, ...argv], errLines: true }));
  if (mode === 'must') {
    return readdirSync(here)
      .filter((f) => f.endsWith('.js'))
      .sort()
      .map((f) => ({ name: f, argv: ['node', f], host: [NODE22, f], errLines: true }));
  }
  if (mode === 'jsh') {
    return readdirSync(here)
      .filter((f) => f.endsWith('.jsh'))
      .sort()
      .map((f) => ({ name: f, argv: ['jsh', f], hostJsh: [f] }));
  }
  if (mode === 'sh') {
    const out = [];
    for (const f of readdirSync(here).filter((x) => x.endsWith('.sh.mjs')).sort()) {
      const list = (await import(pathToFileURL(join(here, f)).href)).default;
      for (const c of list) out.push({ name: `${f.replace(/\.sh\.mjs$/, '')}/${c.name}`, argv: ['bash', '-c', c.cmd], shell: c.cmd, stdin: c.stdin, timeout: c.timeout });
    }
    return out;
  }
  if (mode === 'np') {
    const t = join(here, 'test/parallel');
    return readdirSync(t)
      .filter((f) => f.startsWith('test-'))
      .sort()
      .map((f) => ({ name: f, argv: ['node', f], host: [NODE22, f], cwd: 'test/parallel', statusOnly: true }));
  }
  return [];
}

const hostCache = new Map();
const hostDirs = new Set();
function hostDir(dir, pkgName) {
  const d = join(work, 'hostfx', pkgName, dir);
  if (!hostDirs.has(d)) {
    rmSync(d, { recursive: true, force: true });
    cpSync(join(fx, dir), d, { recursive: true, verbatimSymlinks: true });
    hostDirs.add(d);
  }
  return d;
}
function hostRun(dir, c, pkgName) {
  const key = `${dir}\u0000${c.name}${c.hostJsh || c.shell ? `\u0000${pkgName}` : ''}`;
  if (hostCache.has(key)) return hostCache.get(key);
  const cwd = join(hostDir(dir, c.hostJsh || c.shell ? pkgName : 'node'), c.cwd ?? '');
  let r;
  if (c.shell) {
    r = isolated('/bin/bash', ['-c', c.shell], {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      input: c.stdin ?? '',
      env: { HOME: process.env.HOME, LANG: 'C.UTF-8', PATH: `${hostJsh(pkgName)}:/usr/bin:/bin` },
    });
  } else if (c.hostJsh) {
    r = isolated(join(hostJsh(pkgName), 'jsh'), c.hostJsh, { cwd, encoding: 'utf8', timeout: 60_000, env: { HOME: process.env.HOME, PATH: `${hostJsh(pkgName)}:/usr/bin:/bin` } });
  } else {
    r = isolated(c.host[0], c.host.slice(1), { cwd, encoding: 'utf8', timeout: 60_000, env: { HOME: process.env.HOME, PATH: `${dirnameOf(NODE22)}:/usr/bin:/bin` } });
  }
  const res = { status: r.status ?? r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  hostCache.set(key, res);
  return res;
}

const dirnameOf = (p) => p.replace(/\/[^/]+$/, '');
const SETSID = spawnSync('setsid', ['--version'], { encoding: 'utf8' }).status === 0;
const isolated = (cmd, args, opts) => (SETSID ? spawnSync('setsid', ['--wait', cmd, ...args], opts) : spawnSync(cmd, args, opts));

function render(c, r, norm) {
  if (c.statusOnly) return `rc=${r.status === 0 ? 0 : 'nonzero'}`;
  if (c.shell) return norm(`${r.stdout}${r.stderr ? `\n[stderr] ${r.stderr}` : ''}\n[rc=${r.status}]`);
  if (c.errLines) return norm(`${r.stdout}${r.stderr ? `\n[stderr] ${r.stderr.split('\n').filter((l) => /Error|error/.test(l)).slice(0, 2).join(' | ')}` : ''}\n[rc=${r.status}]`);
  return norm(`${r.stdout}${tail(r.stderr)}\n[rc=${r.status}]`);
}

async function runDirs(pkgName, pkgDir, pick = null) {
  const results = {};
  const dirs = readdirSync(fx)
    .filter((d) => !d.includes('.'))
    .filter((d) => !values.only || values.only.split(',').includes(d))
    .filter((d) => !pick || pick.has(d))
    .sort()
    .filter((d, i) => pick || values.only || i % shardOf === shardIx);
  for (const dir of dirs) {
    const mode = modeOf(dir);
    if (mode === 'skip') {
      results[`${dir}/*`] = { status: 'skip', why: SKIP[dir] };
      continue;
    }
    if (mode === 'row') continue;
    const cases = (await casesFor(dir, mode)).filter((c) => !pick || pick.get(dir).has(c.name));
    if (!cases.length) continue;
    const started = Date.now();
    const user = values.user;
    const kdir = user === 'root' ? `/os/${dir}` : `/home/${user}/${dir}`;
    const fresh = async () => {
      const kk = await boot(pkgDir);
      for (const f of walk(join(fx, dir))) await kk.writeFile(`${kdir}/${relative(join(fx, dir), f).replaceAll('\\', '/')}`, readFileSync(f));
      if (user !== 'root') await krun(kk, ['bash', '-c', `chown -R ${user}:${user} ${kdir}`], { cwd: '/' }, 120_000);
      return kk;
    };
    let k = await fresh();
    const norm = normaliser(hostDir(dir, 'node'), kdir, hostDir(dir, pkgName));
    for (const c of cases) {
      const key = `${dir}/${c.name}`;
      if (SKIP_CASES[key]) {
        results[key] = { status: 'skip', why: SKIP_CASES[key] };
        continue;
      }
      const extra = NORMALIZE.filter(([re]) => re.test(key)).flatMap(([, subs]) => subs);
      const normCase = (t) => extra.reduce((acc, [re, to]) => acc.replace(re, to), norm(t));
      const opts = { cwd: `${kdir}${c.cwd ? `/${c.cwd}` : ''}`, ...(user !== 'root' ? { user } : {}), ...(c.stdin !== undefined ? { stdin: c.stdin } : {}) };
      const r = await krun(k, c.argv, opts, c.timeout ?? CASE_MS);
      const h = hostRun(dir, c, pkgName);
      const a = render(c, r, normCase);
      const b = render(c, h, normCase);
      const same = a === b && r.status !== 'TIMEOUT';
      results[`${dir}/${c.name}`] = { status: same ? 'same' : 'diff', jsh: a.slice(0, 4000), node: same ? undefined : b.slice(0, 4000) };
      if (r.status === 'TIMEOUT' || String(r.status).startsWith('ERROR')) {
        try {
          await k.terminate();
        } catch {}
        k = await fresh();
      }
    }
    try {
      await k.terminate();
    } catch {}
    console.log(`mfixtures ${kernel.id} ${pkgName} ${dir} (${mode}): ${cases.length} case(s), ${Math.round((Date.now() - started) / 1000)}s`);
  }
  return results;
}

async function runRows(pkgName, pkgDir) {
  const results = {};
  if (shardIx !== shardOf - 1 && !values.only) return results;
  for (const row of ROWS) {
    if (values.only && !values.only.split(',').includes(row.name) && !values.only.split(',').some((d) => ROW_DIRS.includes(d))) continue;
    const k = await boot(pkgDir);
    for (const [to, from] of Object.entries(row.files)) await k.writeFile(to, readFileSync(join(fx, from)));
    for (const step of row.steps) {
      const opts = { cwd: step.cwd ?? '/tmp', ...(step.user ? { user: step.user } : {}) };
      const r = await krun(k, ['bash', '-c', step.cmd], opts, 90_000);
      results[`${row.name}/${step.label}`] = { status: 'ran', jsh: `${r.stdout.trim()}${r.stderr.trim() ? `\n[stderr] ${r.stderr.trim().slice(0, 1200)}` : ''}\n[rc=${r.status}]` };
    }
    try {
      await k.terminate();
    } catch {}
    console.log(`mfixtures ${kernel.id} ${pkgName} row ${row.name}: ${row.steps.length} step(s)`);
  }
  return results;
}

process.on('unhandledRejection', (e) => {
  if (!/terminated/.test(String(e))) console.log('# unhandled', String(e).slice(0, 200));
});

const pkgs = { new: stage.published.dir, prev: stage.previous.dir };
if (values.case) {
  const pick = new Map();
  for (const key of values.case.split(',')) {
    const i = key.indexOf('/');
    if (!pick.has(key.slice(0, i))) pick.set(key.slice(0, i), new Set());
    pick.get(key.slice(0, i)).add(key.slice(i + 1));
  }
  const res = {};
  for (const name of values.pkg.split(',')) {
    for (const [key, r] of Object.entries(await runDirs(name, pkgs[name], pick))) res[`${name} ${key}`] = r;
  }
  mkdirSync(join(out, 'reruns'), { recursive: true });
  const file = join(out, 'reruns', `${Date.now()}.json`);
  writeFileSync(file, `${JSON.stringify(res, null, 1)}\n`);
  for (const [key, r] of Object.entries(res)) console.log(`${r.status.toUpperCase()} ${key}${r.status === 'diff' ? `\n--- jsh\n${r.jsh}\n--- node\n${r.node}` : ''}`);
  console.log(`mfixtures: wrote ${file}`);
  process.exit(0);
}
const all = {};
for (const name of values.pkg.split(',')) {
  const res = { ...(await runDirs(name, pkgs[name])), ...(await runRows(name, pkgs[name])) };
  all[name] = res;
  writeFileSync(join(out, `${name}${values.only ? '-only' : suffix}.json`), `${JSON.stringify(res, null, 1)}\n`);
}

const RETRIES = 2;
if (all.new && all.prev) {
  const suspects = Object.keys(all.new).filter((key) => {
    const a = all.new[key]?.status;
    const b = all.prev[key]?.status;
    return (a === 'diff' && b === 'same') || (a === 'same' && b === 'diff');
  });
  const pick = new Map();
  for (const key of suspects) {
    const i = key.indexOf('/');
    const dir = key.slice(0, i);
    if (!pick.has(dir)) pick.set(dir, new Set());
    pick.get(dir).add(key.slice(i + 1));
  }
  for (let attempt = 1; attempt <= RETRIES && pick.size; attempt++) {
    hostCache.clear();
    hostDirs.clear();
    for (const name of ['new', 'prev']) {
      const res = await runDirs(name, pkgs[name], pick);
      for (const [key, r] of Object.entries(res)) {
        if (!all[name][key]) continue;
        all[name][key].retries = [...(all[name][key].retries ?? []), r.status];
      }
    }
  }
  if (suspects.length) console.log(`mfixtures ${kernel.id}: re-ran ${suspects.length} case(s) that changed verdict ${RETRIES} more time(s) on both releases (a diagnostic: the class stays the first run's)`);
}

if (all.new && all.prev && !values.only) {
  const keys = [...new Set([...Object.keys(all.new), ...Object.keys(all.prev)])].sort();
  const rows = keys.map((key) => {
    const a = all.new[key];
    const b = all.prev[key];
    let cls;
    if (a?.status === 'ran' || b?.status === 'ran') cls = a?.jsh === b?.jsh ? 'unchanged' : 'changed';
    else if (a?.status === 'same' && b?.status === 'diff') cls = 'fixed';
    else if (a?.status === 'diff' && b?.status === 'same') cls = 'regression';
    else if (a?.status === 'diff' && b?.status === 'diff') cls = a.jsh === b.jsh ? 'diff-unchanged' : 'diff-changed';
    else if (a?.status === 'same' && b?.status === 'same') cls = 'same';
    else cls = a?.status ?? 'missing';
    const flipped = [a, b].some((x) => (x?.retries ?? []).some((r) => r !== x.status));
    return { key, class: cls, ...(flipped ? { flipped: { new: [a.status, ...(a.retries ?? [])], prev: [b.status, ...(b.retries ?? [])] } } : {}) };
  });
  const pick = (c) => rows.filter((r) => r.class === c).map((r) => r.key);
  const summary = {
    kernel: { id: kernel.id, version: kernel.version, users: 'enforce', user: values.user },
    counts: rows.reduce((acc, r) => ({ ...acc, [r.class]: (acc[r.class] ?? 0) + 1 }), {}),
    regression: pick('regression'),
    fixed: pick('fixed'),
    diffChanged: pick('diff-changed'),
    flipped: rows.filter((r) => r.flipped).map((r) => r.key),
    rowChanged: pick('changed'),
    rows,
  };
  writeFileSync(join(out, `summary${suffix}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`mfixtures ${kernel.id}: ${JSON.stringify(summary.counts)}`);
}
process.exit(0);
