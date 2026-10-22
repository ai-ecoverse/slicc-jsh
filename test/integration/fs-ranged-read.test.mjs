import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh, withJshAndSh } from './helpers.mjs';

// readSync on a regular file opened read-only reads the range asked for from a
// kernel descriptor (#401), not the whole file on every call.
describe('fs.readSync of a read-only file reads a range (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  const run = async (lines) => {
    await jsh.kernel.writeFile('/os/ranged.js', lines.join('\n'));
    const r = await jsh.run(['node', 'ranged.js']);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };

  it("keeps Node's positions: explicit ones leave the fd's alone, null and -1 move it", async () => {
    const out = await run([
      "const fs = require('fs');",
      "fs.writeFileSync('r.txt', 'abcdefghij');",
      "const fd = fs.openSync('r.txt', 'r'); const b = Buffer.alloc(4);",
      "const at = (n) => b.toString('utf8', 0, n);",
      'console.log(at(fs.readSync(fd, b, 0, 3, 5)));',
      'console.log(at(fs.readSync(fd, b, 0, 2, null)));',
      'console.log(at(fs.readSync(fd, b, { length: 2, position: -1 })));',
      'console.log(at(fs.readSync(fd, b, 0, 4, 8)), fs.readSync(fd, b, 0, 4, 10), fs.readSync(fd, b, 0, 0, 0));',
      "console.log(fs.readFileSync(fd, 'utf8'));",
      "console.log(JSON.stringify(fs.readFileSync(fd, 'utf8')));",
      'fs.closeSync(fd);',
      "try { fs.readSync(fd, b); } catch (e) { console.log(e.code); }",
    ]);
    assert.equal(out, 'fgh\nab\ncd\nij 0 0\nefghij\n""\nEBADF\n');
  });

  it('reads many ranges of a large file, and still reads it once unlinked', async () => {
    const out = await run([
      "const fs = require('fs');",
      'const size = 16 * 1024 * 1024; const src = Buffer.alloc(size);',
      'for (let i = 0; i < size; i += 4) src.writeUInt32LE(i, i);',
      "fs.writeFileSync('big.bin', src);",
      "const fd = fs.openSync('big.bin', 'r'); const b = Buffer.alloc(4096);",
      'let ok = 0;',
      'for (let k = 0; k < 512; k++) { const pos = ((k * 7919) % (size / 4096)) * 4096; fs.readSync(fd, b, 0, 4096, pos); if (b.readUInt32LE(0) === pos && b.readUInt32LE(4092) === pos + 4092) ok++; }',
      "fs.unlinkSync('big.bin');",
      'fs.readSync(fd, b, 0, 8, 64);',
      'console.log(ok, b.readUInt32LE(0), b.readUInt32LE(4));',
      'fs.closeSync(fd);',
    ]);
    assert.equal(out, '512 64 68\n');
  });

  it("validates positions as Node does: bigint, -1n, and ERR_OUT_OF_RANGE below -1 (r and r+)", async () => {
    const out = await run([
      "const fs = require('fs');",
      "fs.writeFileSync('p.txt', 'abcdefghij');",
      "for (const flags of ['r', 'r+']) {",
      '  const fd = fs.openSync(\'p.txt\', flags); const b = Buffer.alloc(4); const got = [];',
      "  const at = (n) => b.toString('utf8', 0, n);",
      '  got.push(at(fs.readSync(fd, b, 0, 2, 3n)), at(fs.readSync(fd, b, 0, 2, -1n)), at(fs.readSync(fd, b, 0, 2, -1)));',
      "  for (const p of [-2, 2.5, '5']) { try { fs.readSync(fd, b, 0, 2, p); got.push('read'); } catch (e) { got.push(e.code); } }",
      "  console.log(flags, got.join(' '));",
      '  fs.closeSync(fd);',
      '}',
    ]);
    assert.equal(out, 'r de ab cd ERR_OUT_OF_RANGE ERR_OUT_OF_RANGE ERR_INVALID_ARG_TYPE\nr+ de ab cd ERR_OUT_OF_RANGE ERR_OUT_OF_RANGE ERR_INVALID_ARG_TYPE\n');
  });

  it('is one file throughout: fstat after unlink, and a child stdin after unlink and recreate', async () => {
    const out = await run([
      "const fs = require('fs'); const cp = require('child_process');",
      "fs.writeFileSync('u.txt', 'old file\\n');",
      "const fd = fs.openSync('u.txt', 'r');",
      "fs.unlinkSync('u.txt');",
      'let st = fs.fstatSync(fd); console.log(st.size, st.nlink, st.isFile());',
      "fs.writeFileSync('u.txt', 'a new and longer file\\n');",
      "fs.promises.open('u.txt', 'r').then(async (fh) => { console.log((await fh.stat()).size); await fh.close();",
      "  const fd2 = fs.openSync('u.txt', 'r'); fs.unlinkSync('u.txt'); fs.writeFileSync('u.txt', 'replaced\\n');",
      "  const cat = ['-e', 'process.stdin.pipe(process.stdout)'];",
      "  const child = cp.spawn('node', cat, { stdio: [fd, 'pipe', 'inherit'] }); fs.closeSync(fd);",
      "  let got = ''; child.stdout.on('data', (d) => (got += d)); child.on('close', (code) => {",
      "    console.log(code, JSON.stringify(got));",
      "    const s = cp.spawnSync('node', cat, { stdio: [fd2, 'pipe', 'inherit'] }); console.log(JSON.stringify(String(s.stdout))); fs.closeSync(fd2);",
      '  });',
      '});',
    ]);
    assert.equal(out, '9 0 true\n22\n0 "old file\\n"\n"a new and longer file\\n"\n');
  });

  it("opens a directory 'r' and reads a symlink's target", async () => {
    const out = await run([
      "const fs = require('fs');",
      "fs.mkdirSync('d', { recursive: true }); fs.writeFileSync('t.txt', 'target'); try { fs.unlinkSync('l.txt'); } catch {}",
      "fs.symlinkSync('t.txt', 'l.txt');",
      "const dfd = fs.openSync('d', 'r'); try { fs.readSync(dfd, Buffer.alloc(4)); } catch (e) { console.log(e.code); } fs.closeSync(dfd);",
      "const lfd = fs.openSync('l.txt', 'r'); const b = Buffer.alloc(6); console.log(b.toString('utf8', 0, fs.readSync(lfd, b, 0, 6, 0))); fs.closeSync(lfd);",
    ]);
    assert.equal(out, 'EISDIR\ntarget\n');
  });
});

// The setup chmods from JS (slicc-kernel 1.86.0+).

describe('fs.openSync of a file it may not read (kernel, users: enforce)', () => {
  let jsh;
  before(async () => {
    jsh = await withJshAndSh();
    await jsh.kernel.users.add({ name: 'cone' });
  });
  after(() => jsh?.close());

  it('is EACCES, not an fd that reads it by path', async () => {
    await jsh.kernel.writeFile(
      '/tmp/secret.js',
      [
        "const fs = require('fs');",
        "fs.writeFileSync('secret.txt', 'no'); fs.chmodSync('secret.txt', 0);",
        "try { fs.openSync('secret.txt', 'r'); console.log('opened'); } catch (e) { console.log(e.code, e.syscall, e.path); }",
        "fs.unlinkSync('secret.txt');",
      ].join('\n')
    );
    const r = await jsh.run(['node', '/tmp/secret.js'], { user: 'cone', cwd: '/tmp' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'EACCES open secret.txt\n');
  });
});
