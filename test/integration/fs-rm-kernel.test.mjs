/**
 * fs.rm with recursive under users: 'enforce'. On slicc-kernel 1.88.0+
 * (ctx.kernel) a tree goes to the kernel in one call; when that call is
 * refused partway, jsh walks what is left so the error names the entry and
 * the syscall as Node's rimraf does (host Node 22.22.0 gives the strings
 * asserted here). Older kernels take the walk only, with the same errors.
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
