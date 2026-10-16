import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

export function archive(dir, ref) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync('sh', ['-c', 'git -C "$1" archive --format=tar "$2" | tar -x -C "$3"', 'archive', root, ref, dir], { stdio: 'inherit' });
  return sh('git', ['rev-parse', `${ref}^{commit}`], { cwd: root, quiet: true }).trim();
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
