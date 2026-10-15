const fs = require('fs'), path = require('path'), cp = require('child_process');
const [mode, D, X] = process.argv.slice(2);
const n = (s) => typeof s === 'string' ? s.split(D).join('<D>').split(X || '\u0000').join('<X>') : s;
const er = (e) => e ? `${e.name}|${e.code}|${e.errno}|${e.syscall}|${n(e.path)}|${n(e.message)}` : 'ok';
const m = (p) => (fs.statSync(p).mode & 0o7777).toString(8);
const say = (...a) => console.log(...a.map(n));
const tryS = (l, fn) => { try { const r = fn(); say(l, 'ok', r === undefined ? '' : JSON.stringify(n(r))); } catch (e) { say(l, er(e)); } };
const cbP = (l, fn) => new Promise((res) => { try { fn((e) => { say(l, er(e)); res(); }); } catch (e) { say(l, 'threw', er(e)); res(); } });
const prP = async (l, fn) => { try { await fn(); say(l, 'ok'); } catch (e) { say(l, er(e)); } };
(async () => {
  say('typeof', typeof fs.chmod, typeof fs.chmodSync, typeof fs.fchmod, typeof fs.fchmodSync, typeof fs.promises.chmod);
  if (mode === 'owner') {
    const f = path.join(D, 'f'), d = path.join(D, 'd');
    fs.rmSync(f, { force: true }); fs.rmSync(d, { recursive: true, force: true });
    fs.writeFileSync(f, 'x'); fs.mkdirSync(d);
    say('initial', m(f), m(d));
    tryS('chmodSync 600', () => fs.chmodSync(f, 0o600)); say(' ->', m(f));
    tryS('chmodSync str 640', () => fs.chmodSync(f, '640')); say(' ->', m(f));
    tryS('chmodSync URL 604', () => fs.chmodSync(new URL('file://' + f), 0o604)); say(' ->', m(f));
    await cbP('chmod cb 750', (cb) => fs.chmod(f, 0o750, cb)); say(' ->', m(f));
    await prP('promises.chmod 711', () => fs.promises.chmod(f, 0o711)); say(' ->', m(f));
    const fd = fs.openSync(f, 'r');
    tryS('fchmodSync 700', () => fs.fchmodSync(fd, 0o700)); say(' ->', m(f));
    await cbP('fchmod cb 644', (cb) => fs.fchmod(fd, 0o644, cb)); say(' ->', m(f));
    fs.closeSync(fd);
    const h = await fs.promises.open(f, 'r');
    await prP('filehandle.chmod 755', () => h.chmod(0o755)); say(' ->', m(f)); await h.close();
    tryS('chmodSync dir 700', () => fs.chmodSync(d, 0o700)); say(' ->', m(d));
    tryS('chmodSync dir 1777', () => fs.chmodSync(d, 0o1777)); say(' ->', m(d));
    tryS('chmodSync 0', () => fs.chmodSync(f, 0)); say(' ->', m(f));
    tryS('read after 0', () => fs.readFileSync(f, 'utf8'));
    tryS('chmodSync 644 back', () => fs.chmodSync(f, 0o644)); say(' ->', m(f));
    tryS('chmodSync 10644 masked', () => fs.chmodSync(f, 0o10644)); say(' ->', m(f));
    say('lchmod', typeof fs.lchmod, typeof fs.lchmodSync, typeof fs.promises.lchmod);
    fs.writeFileSync(path.join(D, 'tgt'), 't'); try { fs.unlinkSync(path.join(D, 'ln')); } catch {} fs.symlinkSync(path.join(D, 'tgt'), path.join(D, 'ln'));
    tryS('chmodSync via symlink 600', () => fs.chmodSync(path.join(D, 'ln'), 0o600)); say(' -> target', m(path.join(D, 'tgt')));
  }
  if (mode === 'other') {
    const f = X;
    say('before', m(f));
    tryS('chmodSync', () => fs.chmodSync(f, 0o777));
    await cbP('chmod cb', (cb) => fs.chmod(f, 0o777, cb));
    await prP('promises.chmod', () => fs.promises.chmod(f, 0o777));
    let fd; try { fd = fs.openSync(f, 'r'); } catch (e) { say('open', er(e)); }
    if (fd !== undefined) {
      tryS('fchmodSync', () => fs.fchmodSync(fd, 0o777));
      await cbP('fchmod cb', (cb) => fs.fchmod(fd, 0o777, cb));
      fs.closeSync(fd);
      const h = await fs.promises.open(f, 'r'); await prP('filehandle.chmod', () => h.chmod(0o777)); await h.close();
    }
    say('after', m(f));
  }
  if (mode === 'errors') {
    const f = path.join(D, 'ef'), miss = path.join(D, 'missing');
    fs.writeFileSync(f, 'x');
    tryS('chmodSync missing', () => fs.chmodSync(miss, 0o644));
    await cbP('chmod cb missing', (cb) => fs.chmod(miss, 0o644, cb));
    await prP('promises.chmod missing', () => fs.promises.chmod(miss, 0o644));
    tryS('chmodSync notdir', () => fs.chmodSync(path.join(f, 'x'), 0o644));
    tryS('chmodSync mode abc', () => fs.chmodSync(f, 'abc'));
    tryS('chmodSync mode -1', () => fs.chmodSync(f, -1));
    tryS('chmodSync mode 2**32', () => fs.chmodSync(f, 2 ** 32));
    tryS('chmodSync mode 1.5', () => fs.chmodSync(f, 1.5));
    tryS('chmodSync mode {}', () => fs.chmodSync(f, {}));
    tryS('chmodSync no mode', () => fs.chmodSync(f));
    tryS('chmodSync path 1', () => fs.chmodSync(1, 0o644));
    tryS('chmodSync path NUL', () => fs.chmodSync(f + '\u0000', 0o644));
    await cbP('chmod cb mode abc', (cb) => fs.chmod(f, 'abc', cb));
    tryS('chmod no cb', () => fs.chmod(f, 0o644));
    await prP('promises.chmod mode abc', () => fs.promises.chmod(f, 'abc'));
    tryS('fchmodSync 9999', () => fs.fchmodSync(9999, 0o644));
    tryS('fchmodSync -1', () => fs.fchmodSync(-1, 0o644));
    tryS('fchmodSync "x"', () => fs.fchmodSync('x', 0o644));
    await cbP('fchmod cb 9999', (cb) => fs.fchmod(9999, 0o644, cb));
    say('final', m(f));
  }
  if (mode === 'spawn') {
    const s = path.join(D, 's.sh'), j = path.join(D, 'j.js');
    fs.rmSync(s, { force: true }); fs.rmSync(j, { force: true });
    fs.writeFileSync(s, '#!/bin/sh\necho spawned-ok "$@"\n');
    fs.writeFileSync(j, '#!/usr/bin/env node\nconsole.log("node-shebang-ok", process.argv.slice(2).join(" "))\n');
    say('initial', m(s), m(j));
    const sp = (l, p) => { const r = cp.spawnSync(p, ['a1'], { encoding: 'utf8' }); say(l, r.error ? er(r.error) : `status=${r.status} out=${JSON.stringify(r.stdout.trim())}`); };
    sp('spawnSync 644', s);
    fs.chmodSync(s, 0o755); fs.chmodSync(j, 0o755); say('chmodded', m(s), m(j));
    sp('spawnSync 755', s);
    sp('spawnSync node shebang 755', j);
    tryS('execFileSync 755', () => cp.execFileSync(s, ['b1'], { encoding: 'utf8' }).trim());
    tryS('execSync by path', () => cp.execSync(`${s} c1`, { encoding: 'utf8' }).trim());
    await new Promise((res) => { const c = cp.spawn(s, ['d1']); let o = ''; c.stdout.on('data', (b) => o += b); c.on('error', (e) => { say('spawn async', er(e)); res(); }); c.on('close', (code) => { say('spawn async', `code=${code} out=${JSON.stringify(o.trim())}`); res(); }); });
    fs.chmodSync(s, 0o644); say('back', m(s));
    sp('spawnSync 644 again', s);
    fs.chmodSync(s, 0o700); sp('spawnSync 700', s);
  }
  if (mode === 'mkdir') {
    const d = path.join(D, 'md'), f = path.join(D, 'mf');
    fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(f, { force: true }); fs.writeFileSync(f, 'x');
    tryS('mkdirSync new', () => fs.mkdirSync(d));
    tryS('mkdirSync existing', () => fs.mkdirSync(d));
    tryS('mkdirSync existing recursive', () => fs.mkdirSync(d, { recursive: true }));
    tryS('mkdirSync deep recursive', () => fs.mkdirSync(path.join(d, 'a/b/c'), { recursive: true }));
    tryS('mkdirSync deep non-recursive', () => fs.mkdirSync(path.join(d, 'x/y')));
    tryS('mkdirSync on file', () => fs.mkdirSync(f));
    tryS('mkdirSync on file recursive', () => fs.mkdirSync(f, { recursive: true }));
    tryS('mkdirSync under file recursive', () => fs.mkdirSync(path.join(f, 'z'), { recursive: true }));
    await cbP('mkdir cb existing', (cb) => fs.mkdir(d, cb));
    await cbP('mkdir cb existing recursive', (cb) => fs.mkdir(d, { recursive: true }, cb));
    await prP('promises.mkdir existing', () => fs.promises.mkdir(d));
    await prP('promises.mkdir existing recursive', () => fs.promises.mkdir(d, { recursive: true }));
    tryS('mkdirSync mode 700', () => fs.mkdirSync(path.join(D, 'md7'), 0o700)); say(' ->', m(path.join(D, 'md7')));
    fs.rmSync(path.join(D, 'md7'), { recursive: true });
    tryS('mkdtempSync', () => typeof fs.mkdtempSync(path.join(D, 'tmp-')));
  }
})();
