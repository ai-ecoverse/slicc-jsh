import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

// The golden fixture fs-correctness covers the rest; these cases print a
// DeprecationWarning with a pid on host Node, so they are asserted here.
describe('fs never deletes more than Node (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  it("an append descriptor writes at the end whatever the position (Linux's O_APPEND; macOS's pwrite differs)", async () => {
    const r = await jsh.run([
      'node',
      '-e',
      "const fs=require('fs'); fs.writeFileSync('ap.txt','abc'); let fd=fs.openSync('ap.txt','a'); fs.writeSync(fd,'X',0); fs.closeSync(fd); fd=fs.openSync('ap.txt', fs.constants.O_WRONLY | fs.constants.O_APPEND); fs.writeSync(fd,'Y',1); fs.closeSync(fd); console.log(fs.readFileSync('ap.txt','utf8'))",
    ]);
    assert.equal(r.stdout, 'abcXY\n');
  });

  it('rmdirSync(file, { recursive: true }) is ENOTDIR and keeps the file', async () => {
    await jsh.kernel.writeFile('/os/keep.txt', 'keep\n');
    await jsh.kernel.writeFile(
      '/os/rmdir-file.js',
      [
        "const fs = require('fs');",
        "for (const f of [() => fs.rmdirSync('keep.txt', { recursive: true }), () => fs.promises.rmdir('keep.txt', { recursive: true })]) {",
        '  try { await f(); console.log("removed"); } catch (e) { console.log(e.code, e.syscall); }',
        '}',
        "console.log(fs.readFileSync('keep.txt', 'utf8').trim());",
      ]
        .join('\n')
        .replace(/^/, '(async () => {\n')
        .concat('\n})();\n')
    );
    const r = await jsh.run(['node', 'rmdir-file.js']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'ENOTDIR rmdir\nENOTDIR rmdir\nkeep\n');
  });
});

describe('fs.linkSync goes to the kernel (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    await jsh.kernel.writeFile('/os/t/.keep', '');
    await jsh.kernel.mount({ type: 'tmpfs', source: 'none', target: '/os/t' });
  });
  after(() => jsh?.close());

  it('links on tmpfs (one inode, nlink 2) and passes the root file system’s EPERM through', async () => {
    await jsh.kernel.writeFile(
      '/os/link.js',
      [
        "const fs = require('fs');",
        "fs.writeFileSync('t/a', 'shared');",
        "fs.linkSync('t/a', 't/b');",
        "const a = fs.statSync('t/a'); const b = fs.statSync('t/b');",
        "fs.appendFileSync('t/b', '!');",
        "console.log('tmpfs', a.ino === b.ino, fs.statSync('t/a').nlink, fs.readFileSync('t/a', 'utf8'));",
        "fs.writeFileSync('root-a', 'x');",
        "try { fs.linkSync('root-a', 'root-b'); console.log('root linked'); } catch (e) { console.log('root', e.code, e.syscall, e.path, e.dest); }",
        "try { fs.linkSync('t/missing', 't/x'); } catch (e) { console.log('missing', e.code, e.syscall); }",
      ].join('\n')
    );
    const r = await jsh.run(['node', 'link.js']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'tmpfs true 2 shared!\nroot EPERM link root-a root-b\nmissing ENOENT link\n');
  });
});
