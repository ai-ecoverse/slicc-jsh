import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

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
});
