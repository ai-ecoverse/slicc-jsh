import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRoot } from '@ai-ecoverse/slicc-kernel/node';
import { withJsh } from './helpers.mjs';

const MIB = 1024 * 1024;

async function sized(root, name, size) {
  const dir = await root.getDirectoryHandle('os', { create: true });
  const handle = await dir.getFileHandle(name, { create: true });
  const mib = new Blob([new Uint8Array(MIB)]);
  const parts = [...Array(Math.ceil(size / MIB) - 1).fill(mib), mib.slice(0, size - (Math.ceil(size / MIB) - 1) * MIB)];
  handle.getFile = async () => new File(parts, name);
}

describe('fs.readFile of a file over 2 GiB (kernel)', () => {
  let jsh;
  before(async () => {
    const root = memoryRoot();
    jsh = await withJsh({ root });
    await sized(root, 'two-gib.bin', 2 ** 31);
    await sized(root, 'four-gib.bin', 2 ** 32 + 5);
  });
  after(() => jsh?.close());

  it("is refused before it is read, with Node 22's errors", async () => {
    await jsh.kernel.writeFile(
      '/os/large.js',
      [
        "const fs = require('fs');",
        'const show = (label) => (e) => console.log(label, e ? `${e.name} ${e.code} ${e.message}` : "read");',
        'const sync = (label, fn) => { try { fn(); show(label)(); } catch (e) { show(label)(e); } };',
        '(async () => {',
        "  for (const name of ['two-gib.bin', 'four-gib.bin']) {",
        '    console.log(name, fs.statSync(name).size);',
        "    sync('readFileSync', () => fs.readFileSync(name));",
        "    sync('readFileSync utf8', () => fs.readFileSync(name, 'utf8'));",
        "    sync('readFileSync utf-8', () => fs.readFileSync(name, { encoding: 'utf-8' }));",
        "    sync('readFileSync latin1', () => fs.readFileSync(name, 'latin1'));",
        "    const fd = fs.openSync(name, 'r');",
        "    sync('readFileSync(fd)', () => fs.readFileSync(fd));",
        "    sync('readFileSync(fd) utf8', () => fs.readFileSync(fd, 'utf8'));",
        '    fs.closeSync(fd);',
        "    await new Promise((r) => fs.readFile(name, (e) => r(show('readFile')(e))));",
        "    await new Promise((r) => fs.readFile(name, 'utf8', (e) => r(show('readFile utf8')(e))));",
        "    await fs.promises.readFile(name).then(() => show('promises.readFile')(), show('promises.readFile'));",
        "    await fs.promises.readFile(name, 'utf8').then(() => show('promises.readFile utf8')(), show('promises.readFile utf8'));",
        '    const fh = await fs.promises.open(name);',
        "    await fh.readFile().then(() => show('FileHandle.readFile')(), show('FileHandle.readFile'));",
        "    await fh.readFile('utf8').then(() => show('FileHandle.readFile utf8')(), show('FileHandle.readFile utf8'));",
        "    await fs.promises.readFile(fh).then(() => show('promises.readFile(fh)')(), show('promises.readFile(fh)'));",
        '    await fh.close();',
        '  }',
        '})();',
      ].join('\n')
    );
    const r = await jsh.run(['node', 'large.js']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    const lines = (size) => {
      const large = `RangeError ERR_FS_FILE_TOO_LARGE File size (${size}) is greater than 2 GiB`;
      const long = 'Error ERR_STRING_TOO_LONG Cannot create a string longer than 0x1fffffe8 characters';
      return [
        `readFileSync ${large}`,
        `readFileSync utf8 ${long}`,
        `readFileSync utf-8 ${long}`,
        `readFileSync latin1 ${large}`,
        `readFileSync(fd) ${large}`,
        `readFileSync(fd) utf8 ${long}`,
        `readFile ${large}`,
        `readFile utf8 ${large}`,
        `promises.readFile ${large}`,
        `promises.readFile utf8 ${large}`,
        `FileHandle.readFile ${large}`,
        `FileHandle.readFile utf8 ${large}`,
        `promises.readFile(fh) ${large}`,
      ];
    };
    assert.deepEqual(r.stdout.trimEnd().split('\n'), [
      'two-gib.bin 2147483648',
      ...lines(2 ** 31),
      'four-gib.bin 4294967301',
      ...lines(2 ** 32 + 5),
    ]);
  });
  it("reads a short tail from an fd as Node 22's readFileSync 'utf8' does, and still refuses the buffer", async () => {
    await jsh.kernel.writeFile(
      '/os/tail.js',
      [
        "const fs = require('fs');",
        "const at = (fd) => { const b = Buffer.allocUnsafe(64 * 1024 * 1024); let pos = 0; while (pos < 2 ** 31 - 16) pos += fs.readSync(fd, b, 0, Math.min(b.length, 2 ** 31 - 16 - pos), null); return fd; };",
        "const fd = at(fs.openSync('two-gib.bin', 'r'));",
        "const tail = fs.readFileSync(fd, 'utf8');",
        "console.log(tail.length, JSON.stringify(fs.readFileSync(fd, 'utf-8')));",
        "try { fs.readFileSync(fd); } catch (e) { console.log(e.code); }",
        "try { fs.readFileSync(fd, 'latin1'); } catch (e) { console.log(e.code); }",
        'fs.closeSync(fd);',
      ].join('\n')
    );
    const r = await jsh.run(['node', 'tail.js']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '16 ""\nERR_FS_FILE_TOO_LARGE\nERR_FS_FILE_TOO_LARGE\n');
  });
});
