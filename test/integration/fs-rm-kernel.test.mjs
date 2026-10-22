/**
 * fs.rm with recursive under users: 'enforce'. jsh runs Node 22's rimraf
 * (lib/internal/fs/rimraf.js) step for step over the kernel's calls:
 * rmSync rmdir()s a directory first and only empties it on ENOTEMPTY /
 * EEXIST / EPERM; fs.rm and fs.promises.rm do the same with a directory's
 * entries side by side. rmdir(2) of a directory with entries checks the
 * parent's permission first (EACCES), as Linux does. Host Node 22.22.0 gives
 * the strings and the entries left asserted here.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { kernelAtLeast, kernelVersion, withJshAndSh } from './helpers.mjs';

// The setup chmods from JS (slicc-kernel 1.86.0+).
const needs = kernelAtLeast('1.86.0') ? {} : { skip: `slicc-kernel ${kernelVersion} has no ctx.fs.chmod (1.86.0)` };

const program = (lines) => `(async () => {\n${lines.join('\n')}\n})().catch((e) => { console.error(e); process.exit(1); });\n`;
const ERR = "const err = (e) => `${e.code} ${e.errno} ${e.syscall} ${e.path} ${e.message}`;";
const TRIES = [
  "const tries = {",
  "  rmSync: () => fs.rmSync(t, { recursive: true }),",
  "  'rmSync force': () => fs.rmSync(t, { recursive: true, force: true }),",
  "  'promises.rm': () => fs.promises.rm(t, { recursive: true }),",
  "  'rm callback': () => new Promise((res, rej) => fs.rm(t, { recursive: true }, (e) => (e ? rej(e) : res()))),",
  "};",
  "for (const [name, f] of Object.entries(tries)) { try { await f(); console.log(name, 'ok'); } catch (e) { console.log(name, err(e)); } }",
];

describe('fs.rm recursive refused partway (kernel, users: enforce)', () => {
  let jsh;
  before(async () => {
    jsh = await withJshAndSh();
    await jsh.kernel.users.add({ name: 'cone' });
    await jsh.kernel.users.add({ name: 'other' });
  });
  after(() => jsh?.close());

  it('EACCES: a directory in a read-only one (rmdir names it, as Node does)', needs, async () => {
    await jsh.kernel.writeFile(
      '/tmp/eacces.js',
      program([
        "const fs = require('fs');",
        ERR,
        "const t = 'rmt';",
        "fs.mkdirSync('rmt/a/ro/deep', { recursive: true }); fs.writeFileSync('rmt/a/ro/deep/f', ''); fs.writeFileSync('rmt/a/x', '');",
        "fs.chmodSync('rmt/a/ro', 0o555);",
        ...TRIES,
        "console.log('left', fs.existsSync('rmt/a/ro/deep'));",
        "fs.chmodSync('rmt/a/ro', 0o755); fs.rmSync('rmt', { recursive: true }); console.log('then removed', !fs.existsSync('rmt'));",
      ])
    );
    const r = await jsh.run(['node', '/tmp/eacces.js'], { user: 'cone', cwd: '/tmp' });
    assert.equal(r.status, 0, r.stderr);
    const e = "EACCES -13 rmdir rmt/a/ro/deep EACCES: permission denied, rmdir 'rmt/a/ro/deep'";
    assert.equal(r.stdout, `rmSync ${e}\nrmSync force ${e}\npromises.rm ${e}\nrm callback ${e}\nleft true\nthen removed true\n`);
  });

  it('EPERM: another user’s directory in a sticky one', needs, async () => {
    await jsh.kernel.writeFile(
      '/tmp/sticky-setup.js',
      "const fs = require('fs'); fs.mkdirSync('/tmp/sd'); fs.chmodSync('/tmp/sd', 0o1777);\n"
    );
    assert.equal((await jsh.run(['node', '/tmp/sticky-setup.js'], { cwd: '/tmp' })).status, 0);
    await jsh.kernel.writeFile(
      '/tmp/sticky-other.js',
      "const fs = require('fs'); fs.mkdirSync('/tmp/sd/sub'); fs.chmodSync('/tmp/sd/sub', 0o777); fs.writeFileSync('/tmp/sd/sub/of', ''); fs.chmodSync('/tmp/sd/sub/of', 0o666);\n"
    );
    const o = await jsh.run(['node', '/tmp/sticky-other.js'], { user: 'other', cwd: '/tmp' });
    assert.equal(o.status, 0, o.stderr);
    await jsh.kernel.writeFile(
      '/tmp/eperm.js',
      program(["const fs = require('fs');", ERR, "const t = '/tmp/sd/sub';", ...TRIES, "console.log('left', fs.existsSync('/tmp/sd/sub'));"])
    );
    const r = await jsh.run(['node', '/tmp/eperm.js'], { user: 'cone', cwd: '/tmp' });
    assert.equal(r.status, 0, r.stderr);
    const e = "EPERM -1 rmdir /tmp/sd/sub EPERM: operation not permitted, rmdir '/tmp/sd/sub'";
    assert.equal(r.stdout, `rmSync ${e}\nrmSync force ${e}\npromises.rm ${e}\nrm callback ${e}\nleft true\n`);
  });

  it('a lookup refused under an untraversable directory: lstat, or with force and recursive unlink, as Node gives it', needs, async () => {
    await jsh.kernel.writeFile(
      '/tmp/locked.js',
      program([
        "const fs = require('fs');",
        ERR,
        "fs.mkdirSync('locked'); fs.writeFileSync('locked/x', ''); fs.chmodSync('locked', 0);",
        "for (const o of [{ recursive: true, force: true }, { recursive: true }, { force: true }]) { try { fs.rmSync('locked/x', o); console.log('ok'); } catch (e) { console.log(err(e)); } }",
        "fs.chmodSync('locked', 0o755); fs.rmSync('locked', { recursive: true });",
      ])
    );
    const r = await jsh.run(['node', '/tmp/locked.js'], { user: 'cone', cwd: '/tmp' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout,
      [
        "EACCES -13 unlink locked/x EACCES: permission denied, unlink 'locked/x'",
        "EACCES -13 lstat locked/x EACCES: permission denied, lstat 'locked/x'",
        "EACCES -13 lstat locked/x EACCES: permission denied, lstat 'locked/x'",
        '',
      ].join('\n')
    );
  });

  it('/dev as a user (#188, #249): rmSync of /dev/null and of /dev recursively throw EACCES, /dev naming its own rmdir as Node; /dev/null stays', async () => {
    await jsh.kernel.writeFile(
      '/tmp/devrm.js',
      program([
        "const fs = require('fs');",
        ERR,
        "console.log('first', fs.readdirSync('/dev')[0]);",
        "for (const [name, f] of [['rmSync /dev/null', () => fs.rmSync('/dev/null')], ['rmSync /dev/null force', () => fs.rmSync('/dev/null', { force: true })], ['rmSync /dev recursive', () => fs.rmSync('/dev', { recursive: true })], ['unlinkSync /dev/null', () => fs.unlinkSync('/dev/null')], ['promises.unlink /dev/null', () => fs.promises.unlink('/dev/null')], ['unlink callback /dev/null', () => new Promise((res, rej) => fs.unlink('/dev/null', (e) => (e ? rej(e) : res())))], ['promises.rm /dev', () => fs.promises.rm('/dev', { recursive: true })]]) {",
        "  try { await f(); console.log(name, 'ok'); } catch (e) { console.log(name, err(e)); }",
        '}',
        "console.log('/dev/null still there', fs.existsSync('/dev/null'));",
      ])
    );
    const r = await jsh.run(['node', '/tmp/devrm.js'], { user: 'cone', cwd: '/tmp' });
    assert.equal(r.status, 0, r.stderr);
    // rmdir('/dev') as a user: Linux refuses it on '/' (not writable) before
    // it looks at /dev's entries, so rimraf stops there. Host Node 22.22.0 as
    // a user on hosted ubuntu-latest and on the bench pool: EACCES rmdir /dev
    // (ai-ecoverse/slicc-jsh#249; #215 had it as the first entry's unlink).
    const first = `/dev/${/^first (.+)$/m.exec(r.stdout)[1]}`;
    // Before slicc-kernel 1.86.0 jsh doesn't check modes (the kernel's are
    // defaults it doesn't enforce): rmdir is ENOTEMPTY, and the first entry's
    // unlink is refused.
    const dev = kernelAtLeast('1.86.0')
      ? "EACCES -13 rmdir /dev EACCES: permission denied, rmdir '/dev'"
      : `EACCES -13 unlink ${first} EACCES: permission denied, unlink '${first}'`;
    assert.equal(
      r.stdout,
      [
        `first ${first.slice(5)}`,
        "rmSync /dev/null EACCES -13 unlink /dev/null EACCES: permission denied, unlink '/dev/null'",
        "rmSync /dev/null force EACCES -13 unlink /dev/null EACCES: permission denied, unlink '/dev/null'",
        `rmSync /dev recursive ${dev}`,
        "unlinkSync /dev/null EACCES -13 unlink /dev/null EACCES: permission denied, unlink '/dev/null'",
        "promises.unlink /dev/null EACCES -13 unlink /dev/null EACCES: permission denied, unlink '/dev/null'",
        "unlink callback /dev/null EACCES -13 unlink /dev/null EACCES: permission denied, unlink '/dev/null'",
        `promises.rm /dev ${dev}`,
        '/dev/null still there true',
        '',
      ].join('\n')
    );
  });

  it('a 0555 subdirectory of the user\'s own tree: rmSync stops at its rmdir and keeps the rest; rm and promises.rm remove its siblings, as Node (#249)', needs, async () => {
    // Node's rmSync rmdir()s
    // t6, a and b (ENOTEMPTY, so on to their entries, in readdir order),
    // then c: EACCES, b being 0555. Nothing is removed. Node's callback
    // rimraf works through each directory's entries side by side: x, ln and
    // a/y go, b's entries are refused. Node's thread pool may report c's
    // rmdir or z's unlink first (host Node 22.22.0: about half and half);
    // jsh's steps run in the order they're issued, so c's rmdir.
    await jsh.kernel.writeFile(
      '/tmp/rm555.js',
      program([
        "const fs = require('fs'), path = require('path');",
        ERR,
        "const tree = (root) => { fs.mkdirSync(path.join(root, 'a/b/c'), { recursive: true }); for (const f of ['x', 'a/y', 'a/b/z', 'a/b/c/w']) fs.writeFileSync(path.join(root, f), f); fs.symlinkSync('a/y', path.join(root, 'ln')); };",
        "const ls = (p) => { const o = []; const w = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const q = path.join(d, e.name); o.push(path.relative(p, q)); if (e.isDirectory()) w(q); } }; w(p); return o.join(' '); };",
        "const t = 't6';",
        "const tries = {",
        "  rmSync: () => fs.rmSync(t, { recursive: true }),",
        "  'rm callback': () => new Promise((res, rej) => fs.rm(t, { recursive: true }, (e) => (e ? rej(e) : res()))),",
        "  'promises.rm': () => fs.promises.rm(t, { recursive: true }),",
        "};",
        "for (const [name, f] of Object.entries(tries)) {",
        "  tree(t); fs.chmodSync('t6/a/b', 0o555);",
        "  try { await f(); console.log(name, 'ok'); } catch (e) { console.log(name, err(e)); }",
        "  console.log(' left', ls(t)); fs.chmodSync('t6/a/b', 0o755); fs.rmSync(t, { recursive: true });",
        "}",
      ])
    );
    const r = await jsh.run(['node', '/tmp/rm555.js'], { user: 'cone', cwd: '/tmp' });
    assert.equal(r.status, 0, r.stderr);
    const c = "EACCES -13 rmdir t6/a/b/c EACCES: permission denied, rmdir 't6/a/b/c'";
    assert.equal(
      r.stdout,
      [
        `rmSync ${c}`,
        ' left a a/b a/b/c a/b/c/w a/b/z a/y ln x',
        `rm callback ${c}`,
        ' left a a/b a/b/c a/b/c/w a/b/z',
        `promises.rm ${c}`,
        ' left a a/b a/b/c a/b/c/w a/b/z',
        '',
      ].join('\n')
    );
  });

  it('a 500-file tree with a symlink out of it goes; the link target stays', async () => {
    await jsh.kernel.writeFile(
      '/tmp/big.js',
      program([
        "const fs = require('fs');",
        "for (let i = 0; i < 20; i++) { fs.mkdirSync(`big/d${i}`, { recursive: true }); for (let j = 0; j < 25; j++) fs.writeFileSync(`big/d${i}/f${j}`, 'x'); }",
        "fs.symlinkSync('/tmp/keep.txt', 'big/link'); fs.writeFileSync('/tmp/keep.txt', 'k');",
        "fs.rmSync('big', { recursive: true });",
        "console.log(fs.existsSync('big'), fs.readFileSync('/tmp/keep.txt', 'utf8'));",
      ])
    );
    const r = await jsh.run(['node', '/tmp/big.js'], { user: 'cone', cwd: '/tmp' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'false k\n');
  });
});
