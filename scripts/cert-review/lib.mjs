import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const NAME = '@ai-ecoverse/slicc-jsh';
export const KERNEL = '@ai-ecoverse/slicc-kernel';
export const SEMVER = /^\d+\.\d+\.\d+$/;
export const npmFlags = ['--no-audit', '--no-fund'];

export function sh(cmd, args, opts = {}) {
  if (!opts.quiet) console.log(`cert-review: ${opts.cwd ? `(${opts.cwd}) ` : ''}${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  });
}

export const sha = (algo, file, enc = 'hex') => createHash(algo).update(readFileSync(file)).digest(enc);
export const sri = (file) => `sha512-${sha('sha512', file, 'base64')}`;
export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

export function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

export const relFiles = (dir) => walk(dir).map((f) => relative(dir, f).replaceAll('\\', '/')).sort();

export function packFrom(spec, dest) {
  mkdirSync(dest, { recursive: true });
  const out = sh('npm', ['pack', spec, '--silent', '--pack-destination', dest]).trim().split('\n').at(-1);
  return join(dest, out);
}

export function untar(tgz, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  sh('tar', ['-xzf', tgz, '-C', dir]);
  return join(dir, 'package');
}

export function atLeast(version, min) {
  const a = version.split(/[.-]/).map(Number);
  const b = min.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
}

const guardText = readFileSync(join(root, 'scripts/mem-guard.sh'), 'utf8');
export const CAPS = {
  sumKb: Number(/^SUM_KB=(\d+)/m.exec(guardText)[1]),
  perKb: Number(/^PER_KB=(\d+)/m.exec(guardText)[1]),
};

function processTable() {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n');
  return rows.map((l) => l.trim().split(/\s+/).map(Number));
}

function treeOf(rootPid, table) {
  const kids = new Map();
  for (const [pid, ppid] of table) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  const out = [rootPid];
  for (let i = 0; i < out.length; i++) out.push(...(kids.get(out[i]) ?? []));
  return out;
}

export function guarded(cmd, args, { cwd, env, log, timeoutMs, caps = CAPS }) {
  return new Promise((resolvePromise) => {
    const fd = openSync(log, 'w');
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', fd, fd], detached: true });
    let breach = null;
    let peakKb = 0;
    const kill = () => {
      const pids = treeOf(child.pid, processTable()).reverse();
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    };
    const timer = setInterval(() => {
      let table;
      try {
        table = processTable();
      } catch {
        return;
      }
      const rss = new Map(table.map(([pid, , kb]) => [pid, kb]));
      const pids = treeOf(child.pid, table);
      const sum = pids.reduce((n, p) => n + (rss.get(p) ?? 0), 0);
      peakKb = Math.max(peakKb, sum);
      const worst = pids.find((p) => (rss.get(p) ?? 0) > caps.perKb);
      if (worst) breach = `pid ${worst} rss ${rss.get(worst)} KB > PER_KB=${caps.perKb}`;
      else if (sum > caps.sumKb) breach = `tree rss ${sum} KB > SUM_KB=${caps.sumKb}`;
      if (breach) {
        clearInterval(timer);
        kill();
      }
    }, 500);
    const deadline = setTimeout(() => {
      breach = `timeout after ${Math.round(timeoutMs / 1000)}s`;
      kill();
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearInterval(timer);
      clearTimeout(deadline);
      closeSync(fd);
      resolvePromise({ exit: breach ? 137 : (code ?? `signal ${signal}`), breach, peakKb });
    });
  });
}

export function archive(dir, ref, repo = root) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync('sh', ['-c', 'git -C "$1" archive --format=tar "$2" | tar -x -C "$3"', 'archive', repo, ref, dir], { stdio: 'inherit' });
  return sh('git', ['rev-parse', `${ref}^{commit}`], { cwd: repo, quiet: true }).trim();
}

export function packTree(dir, version, commit, dest, ref) {
  const setVersion = () => sh('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], { cwd: dir });
  setVersion();
  sh('npm', ['pkg', 'set', `gitHead=${commit}`], { cwd: dir });
  mkdirSync(dest, { recursive: true });
  const before = new Set(readdirSync(dest));
  sh('npm', ['pack', '--silent', '--pack-destination', dest], { cwd: dir, env: { ...process.env, SLICC_JSH_STRIP_SCRIPTS: '1' } });
  const made = readdirSync(dest).filter((f) => f.endsWith('.tgz') && !before.has(f));
  if (made.length !== 1) throw new Error(`npm pack in ${dir} made ${made.length} tarballs`);
  for (const f of ['package.json', 'package-lock.json']) writeFileSync(join(dir, f), sh('git', ['show', `${ref}:${f}`], { cwd: root, quiet: true }));
  setVersion();
  return join(dest, made[0]);
}

export function manifestOf(tgz) {
  return JSON.parse(execFileSync('tar', ['-xzf', tgz, '-O', 'package/package.json'], { encoding: 'utf8' }));
}

export async function progressRun(k, argv, opts, { quiet, outer }) {
  let so = '';
  let se = '';
  let tail = '';
  const start = Date.now();
  let last = start;
  const seen = (t) => {
    last = Date.now();
    tail = (tail + t).slice(-120);
  };
  let watch;
  const stuck = new Promise((res) => {
    watch = setInterval(() => {
      const now = Date.now();
      const why = now - last >= quiet ? `no output for ${quiet / 1000} s` : now - start >= outer ? `still running` : null;
      if (why) res({ status: 'TIMEOUT', why: `${why} after ${Math.round((now - start) / 1000)} s; ${tail ? `it last printed ${JSON.stringify(tail)}` : 'it printed nothing'}` });
    }, 250);
  });
  const r = await Promise.race([
    k
      .run(argv, {
        ...opts,
        onStdout: (t) => {
          so += t;
          seen(t);
        },
        onStderr: (t) => {
          se += t;
          seen(t);
        },
      })
      .catch((e) => ({ status: `ERROR ${e.message}`, stdout: so, stderr: se })),
    stuck,
  ]);
  clearInterval(watch);
  return r.status === 'TIMEOUT' ? { status: 'TIMEOUT', stdout: so, stderr: se, why: r.why } : r;
}

export function kernelFits(range, kernel) {
  const m = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(String(range).trim());
  if (!m) throw new Error(`engines.slicc-kernel ${range} is not >=x.y.z`);
  const want = m.slice(1).map(Number);
  const have = kernel.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i] > want[i];
  return true;
}

export function kernelPackage(base, sub, kernel) {
  const dir = join(base, '@ai-ecoverse', sub);
  const own = readJson(join(dir, 'package.json'));
  const range = own.engines?.['slicc-kernel'];
  if (!range || kernelFits(range, kernel)) return { dir, version: own.version };
  const compat = join(base, `cert-compat-${sub}`);
  const alt = existsSync(join(compat, 'package.json')) ? readJson(join(compat, 'package.json')) : null;
  const altRange = alt?.engines?.['slicc-kernel'];
  if (alt?.name === own.name && (!altRange || kernelFits(altRange, kernel))) return { dir: compat, version: alt.version, compat: true };
  throw new Error(
    `kernel ${kernel}: ${own.name}@${own.version} needs slicc-kernel ${range}, and no cert-compat-${sub} devDependency fits it${alt ? ` (${alt.name}@${alt.version} needs ${altRange})` : ''}`
  );
}
