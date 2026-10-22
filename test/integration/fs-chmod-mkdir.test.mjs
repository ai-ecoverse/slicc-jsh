/**
 * fs.chmod* on slicc-kernel 1.86.0's ctx.sync.fs.chmod / ctx.fs.chmod
 * (ai-ecoverse/slicc-kernel#495) and non-recursive fs.mkdir* on its exclusive
 * mkdir (#514). On an older kernel jsh keeps its fallback (chmod changes
 * nothing, mkdir checks, then creates).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { kernelAtLeast, kernelVersion, withJshAndSh } from './helpers.mjs';

const HAS_CHMOD = kernelAtLeast('1.86.0');
const needs = HAS_CHMOD ? {} : { skip: `slicc-kernel ${kernelVersion} has no ctx.fs.chmod (1.86.0)` };

const program = (lines) => `(async () => {\n${lines.join('\n')}\n})().catch((e) => { console.error(e); process.exit(1); });\n`;
const ERR = "const err = (e) => `${e.code} ${e.syscall} ${e.path} ${e.message}`;";

describe('fs.chmod then exec by path (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJshAndSh();
  });
  after(() => jsh?.close());

  const WRITE_SCRIPTS = [
    "const fs = require('fs'); const cp = require('child_process');",
    "fs.writeFileSync('/os/x/hi.sh', '#!/bin/sh\\necho sh \"$@\"\\n');",
    "fs.writeFileSync('/os/x/hi.js', '#!/usr/bin/env node\\nconsole.log(\"node\", process.argv.slice(2).join(\",\"))\\n');",
    "fs.writeFileSync('/os/x/hi.jsh', 'console.log(\"jsh\", process.argv.slice(2).join(\",\"))\\n');",
    "const run = (f) => { const r = cp.spawnSync(f, ['a', 'b'], { encoding: 'utf8' }); return r.error ? r.error.code : `${r.status} ${r.stdout.trim()}`; };",
  ];

  it('chmodSync(f, 0o755), fs.chmod and fs.promises.chmod make a script JS wrote runnable (spawn, #! and binfmt)', needs, async () => {
    await jsh.kernel.writeFile('/os/x/.keep', '');
    await jsh.kernel.writeFile(
      '/os/chx.js',
      program([
        ...WRITE_SCRIPTS,
        "console.log('before', run('/os/x/hi.sh'));",
        "fs.chmodSync('/os/x/hi.sh', 0o755);",
        "await new Promise((res, rej) => fs.chmod('/os/x/hi.js', '755', (e) => (e ? rej(e) : res())));",
        "await fs.promises.chmod('/os/x/hi.jsh', 0o700);",
        "for (const f of ['hi.sh', 'hi.js', 'hi.jsh']) console.log(f, (fs.statSync('/os/x/' + f).mode & 0o777).toString(8), run('/os/x/' + f));",
        "console.log('execFileSync', cp.execFileSync('/os/x/hi.sh', ['c'], { encoding: 'utf8' }).trim());",
      ])
    );
    const r = await jsh.run(['node', 'chx.js']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout,
      [
        'before EACCES',
        'hi.sh 755 0 sh a b',
        'hi.js 755 0 node a,b',
        'hi.jsh 700 0 jsh a,b',
        'execFileSync sh c',
        '',
      ].join('\n')
    );
    // And from the shell, which the kernel checks the same way.
    const sh = await jsh.run(['sh', '-c', '/os/x/hi.sh z && /os/x/hi.js y && /os/x/hi.jsh w']);
    assert.equal(sh.status, 0, sh.stderr);
    assert.equal(sh.stdout, 'sh z\nnode y\njsh w\n');
  });

  it('fchmodSync and FileHandle.chmod by the descriptor’s path', needs, async () => {
    await jsh.kernel.writeFile(
      '/os/fchx.js',
      program([
        ...WRITE_SCRIPTS,
        "const fd = fs.openSync('/os/x/hi.sh', 'r'); fs.fchmodSync(fd, 0o750); fs.closeSync(fd);",
        "const fh = await fs.promises.open('/os/x/hi.js', 'r'); await fh.chmod(0o500); await fh.close();",
        "for (const f of ['hi.sh', 'hi.js']) console.log(f, (fs.statSync('/os/x/' + f).mode & 0o777).toString(8), run('/os/x/' + f));",
      ])
    );
    const r = await jsh.run(['node', 'fchx.js']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'hi.sh 750 0 sh a b\nhi.js 500 0 node a,b\n');
  });

  it('a pnpm add -g style shim written from JS runs by name from $PNPM_HOME/bin (root and a user)', needs, async () => {
    const shim = (pnpmHome, pkgDir) =>
      program([
        "const fs = require('fs'); const path = require('path'); const cp = require('child_process');",
        `const pnpmHome = ${JSON.stringify(pnpmHome)}; const pkg = ${JSON.stringify(pkgDir)};`,
        "await fs.promises.mkdir(path.join(pkg, 'bin'), { recursive: true });",
        "await fs.promises.writeFile(path.join(pkg, 'bin', 'cli.js'), '#!/usr/bin/env node\\nconsole.log(\"shim\", process.argv.slice(2).join(\",\")); process.exitCode = 4;\\n');",
        // As @zkochan/cmd-shim writes it: a sh shim, then chmod 0o755.
        "const to = path.join(pnpmHome, 'bin', 'shimmed');",
        "await fs.promises.mkdir(path.dirname(to), { recursive: true });",
        "await fs.promises.writeFile(to, `#!/bin/sh\\nexec node \"${pkg}/bin/cli.js\" \"$@\"\\n`, 'utf8');",
        "await fs.promises.chmod(to, 0o755);",
        // By path, and by name through a shell's PATH search (jsh's spawn
        // finds kernel commands by name, not files on PATH).
        "const env = { ...process.env, PATH: `${path.dirname(to)}:${process.env.PATH}` };",
        "for (const argv of [[to, 'p', 'q'], ['sh', '-c', 'shimmed p q']]) {",
        "  const r = cp.spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', env });",
        "  console.log(r.error ? r.error.code : `${r.status} ${r.stdout.trim()}`);",
        "}",
      ]);
    await jsh.kernel.writeFile('/os/shim-root.js', shim('/usr/local/share/pnpm', '/usr/local/share/pnpm/global/shimmed'));
    const root = await jsh.run(['node', 'shim-root.js']);
    assert.equal(root.status, 0, root.stderr);
    assert.equal(root.stdout, '4 shim p,q\n4 shim p,q\n');
    const viaPath = await jsh.run(['sh', '-c', 'shimmed r; echo $?'], {
      env: { PATH: '/usr/local/share/pnpm/bin:/usr/bin:/bin' },
    });
    assert.equal(viaPath.stdout, 'shim r\n4\n', viaPath.stderr);

    const user = await jsh.kernel.users.add({ name: 'shimuser' });
    const home = user.home;
    await jsh.kernel.writeFile('/tmp/shim-user.js', shim(`${home}/.local/share/pnpm`, `${home}/.local/share/pnpm/global/shimmed`));
    const mine = await jsh.run(['node', '/tmp/shim-user.js'], { user: 'shimuser', cwd: home });
    assert.equal(mine.status, 0, mine.stderr);
    assert.equal(mine.stdout, '4 shim p,q\n4 shim p,q\n');
  });
});

describe('fs.chmod under users: enforce (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJshAndSh();
    await jsh.kernel.users.add({ name: 'cone' });
    await jsh.kernel.users.add({ name: 'other' });
    await jsh.kernel.writeFile('/tmp/root-owned', 'r');
  });
  after(() => jsh?.close());

  it('only the owner or root may change a mode: EPERM for anyone else, with Node’s error', needs, async () => {
    await jsh.kernel.writeFile(
      '/tmp/eperm.js',
      program([
        "const fs = require('fs');",
        ERR,
        "const perm = (p) => (fs.statSync(p).mode & 0o7777).toString(8);",
        "const mode = process.argv[2] === 'own' ? 0o600 : 0o777;",
        "if (process.argv[2] === 'own') { fs.writeFileSync('/tmp/cone-owned', 'c'); fs.chmodSync('/tmp/cone-owned', 0o640); console.log('own', perm('/tmp/cone-owned')); }",
        "try { fs.chmodSync('/tmp/root-owned', mode); console.log('chmodSync ok'); } catch (e) { console.log('chmodSync', err(e)); }",
        "try { await fs.promises.chmod('/tmp/root-owned', mode); console.log('promises ok'); } catch (e) { console.log('promises', err(e)); }",
        "await new Promise((res) => fs.chmod('/tmp/root-owned', mode, (e) => { console.log('callback', e ? err(e) : 'ok'); res(); }));",
        "const fd = fs.openSync('/tmp/root-owned', 'r');",
        "try { fs.fchmodSync(fd, mode); console.log('fchmodSync ok'); } catch (e) { console.log('fchmodSync', err(e)); }",
        "fs.closeSync(fd);",
        "console.log('mode', perm('/tmp/root-owned'));",
      ])
    );
    const cone = await jsh.run(['node', '/tmp/eperm.js', 'own'], { user: 'cone', cwd: '/tmp' });
    assert.equal(cone.status, 0, cone.stderr);
    const eperm = "EPERM chmod /tmp/root-owned EPERM: operation not permitted, chmod '/tmp/root-owned'";
    assert.equal(
      cone.stdout,
      [
        'own 640',
        `chmodSync ${eperm}`,
        `promises ${eperm}`,
        `callback ${eperm}`,
        'fchmodSync EPERM fchmod undefined EPERM: operation not permitted, fchmod',
        'mode 644',
        '',
      ].join('\n')
    );
    // Another user can't change cone's file either; root can.
    await jsh.kernel.writeFile(
      '/tmp/eperm2.js',
      "const fs = require('fs'); try { fs.chmodSync('/tmp/cone-owned', 0o666); console.log('ok', (fs.statSync('/tmp/cone-owned').mode & 0o777).toString(8)); } catch (e) { console.log(e.code, e.syscall); }\n"
    );
    const other = await jsh.run(['node', '/tmp/eperm2.js'], { user: 'other', cwd: '/tmp' });
    assert.equal(other.stdout, 'EPERM chmod\n', other.stderr);
    const root = await jsh.run(['node', '/tmp/eperm2.js'], { cwd: '/tmp' });
    assert.equal(root.stdout, 'ok 666\n', root.stderr);
  });
});

describe('fs.mkdir without recursive is exclusive in the kernel', () => {
  let jsh;
  before(async () => {
    jsh = await withJshAndSh();
  });
  after(() => jsh?.close());

  it('two processes make the same 200 directories at once: each is made by exactly one', needs, async () => {
    const N = 200;
    await jsh.kernel.writeFile(
      '/os/race.js',
      [
        "const fs = require('fs');",
        'const [, , me, at] = process.argv;',
        // Both start their loop at the same moment.
        'while (Date.now() < Number(at)) {}',
        'const won = [];',
        `for (let i = 0; i < ${N}; i++) {`,
        "  try { fs.mkdirSync(`/tmp/race/d${i}`); won.push(i); } catch (e) { if (e.code !== 'EEXIST' || e.syscall !== 'mkdir') throw e; }",
        '}',
        'console.log(won.join(","));',
      ].join('\n')
    );
    await jsh.kernel.writeFile('/tmp/race/.keep', '');
    const at = String(Date.now() + 1500);
    const [a, b] = await Promise.all([jsh.run(['node', 'race.js', 'a', at]), jsh.run(['node', 'race.js', 'b', at])]);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    const wonA = a.stdout.trim() ? a.stdout.trim().split(',').map(Number) : [];
    const wonB = b.stdout.trim() ? b.stdout.trim().split(',').map(Number) : [];
    assert.deepEqual(wonA.filter((i) => wonB.includes(i)), [], 'no directory made twice');
    assert.equal(wonA.length + wonB.length, N, 'every directory made once');
  });

  it('promises.mkdir and the callback mkdir lose with EEXIST as well', needs, async () => {
    await jsh.kernel.writeFile(
      '/os/race2.js',
      program([
        "const fs = require('fs');",
        "const tries = [fs.promises.mkdir('/tmp/one'), fs.promises.mkdir('/tmp/one'), new Promise((res, rej) => fs.mkdir('/tmp/one', (e) => (e ? rej(e) : res())))];",
        "const out = await Promise.allSettled(tries);",
        "console.log(out.map((o) => (o.status === 'fulfilled' ? 'won' : o.reason.code)).sort().join(' '));",
      ])
    );
    const r = await jsh.run(['node', 'race2.js']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'EEXIST EEXIST won\n');
  });
});
