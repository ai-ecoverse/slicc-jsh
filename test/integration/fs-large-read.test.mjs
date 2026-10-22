import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRoot } from '@ai-ecoverse/slicc-kernel/node';
import { withJsh, wrapCommandMain } from './helpers.mjs';

const MIB = 1024 * 1024;

const unreadable = () => Promise.reject(new DOMException('a stand-in for a file too large to hold', 'NotReadableError'));

async function sized(root, name, size, { readable = MIB * 64 } = {}) {
  const dir = await root.getDirectoryHandle('os', { create: true });
  const handle = await dir.getFileHandle(name, { create: true });
  const mib = new Blob([new Uint8Array(MIB)]);
  const parts = [...Array(Math.ceil(size / MIB) - 1).fill(mib), mib.slice(0, size - (Math.ceil(size / MIB) - 1) * MIB)];
  class Large extends File {
    slice(start = 0, end = this.size) {
      return end > readable ? { size: end - start, arrayBuffer: unreadable } : super.slice(start, end);
    }
    arrayBuffer() {
      return this.size > readable ? unreadable() : super.arrayBuffer();
    }
  }
  handle.getFile = async () => new Large(parts, name);
}

describe('fs.readFile of a file over 2 GiB (kernel)', () => {
  let jsh;
  before(async () => {
    const root = memoryRoot();
    jsh = await withJsh({ root });
    await sized(root, 'two-gib.bin', 2 ** 31);
    await sized(root, 'four-gib.bin', 2 ** 32 + 5);
    await sized(root, 'tail.bin', 2 ** 31, { readable: Infinity });
    await sized(root, 'under.bin', 2 ** 31 - 1);
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
        "const fd = at(fs.openSync('tail.bin', 'r'));",
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
  it('gives V8\'s RangeError for a file under 2 GiB the realm cannot allocate, where the kernel read is EIO', async () => {
    await jsh.kernel.writeFile(
      '/os/under.js',
      [
        "const fs = require('fs');",
        'const SIZE = 2 ** 31 - 1;',
        'const Real = globalThis.ArrayBuffer;',
        "globalThis.ArrayBuffer = new Proxy(Real, { construct: (target, args, newTarget) => { if (args[0] === SIZE) throw new RangeError('Array buffer allocation failed'); return Reflect.construct(target, args, newTarget); } });",
        'const show = (label) => (e) => console.log(label, e ? `${e.name} ${e.code} ${e.message}` : "read");',
        'const sync = (label, fn) => { try { fn(); show(label)(); } catch (e) { show(label)(e); } };',
        '(async () => {',
        "  sync('readFileSync', () => fs.readFileSync('under.bin'));",
        "  const fd = fs.openSync('under.bin', 'r');",
        "  sync('readFileSync(fd)', () => fs.readFileSync(fd));",
        '  fs.closeSync(fd);',
        "  await new Promise((r) => fs.readFile('under.bin', (e) => r(show('readFile')(e))));",
        "  await fs.promises.readFile('under.bin').then(() => show('promises.readFile')(), show('promises.readFile'));",
        "  const fh = await fs.promises.open('under.bin');",
        "  await fh.readFile().then(() => show('FileHandle.readFile')(), show('FileHandle.readFile'));",
        '  await fh.close();',
        '  globalThis.ArrayBuffer = Real;',
        "  sync('readFileSync, the allocation possible', () => fs.readFileSync('under.bin'));",
        '})();',
      ].join('\n')
    );
    const r = await jsh.run(['node', 'under.js']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    const failed = 'RangeError undefined Array buffer allocation failed';
    assert.deepEqual(r.stdout.trimEnd().split('\n'), [
      `readFileSync ${failed}`,
      `readFileSync(fd) ${failed}`,
      `readFile ${failed}`,
      `promises.readFile ${failed}`,
      `FileHandle.readFile ${failed}`,
      "readFileSync, the allocation possible Error EIO EIO: i/o error, open 'under.bin'",
    ]);
  });
});

describe('fs.readFile of a utf8 text longer than a string can be (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    await jsh.kernel.writeFile(
      '/node_modules/longnode/package.json',
      JSON.stringify({ name: 'longnode', version: '1.0.0', type: 'module', slicc: { commands: { longnode: { abi: 'js', module: 'index.mjs' } } } })
    );
    await jsh.kernel.writeFile(
      '/node_modules/longnode/index.mjs',
      wrapCommandMain(
        'node',
        `class Long extends Uint8Array {
  get length() {
    return 0x1fffffe8 + 1;
  }
}
const long = (path, bytes) => (String(path).endsWith('/long.txt') ? new Long(0) : bytes);
const wrap = (target, replace) => new Proxy(target, {
  get(t, key) {
    if (key in replace) return replace[key];
    const value = Reflect.get(t, key, t);
    return typeof value === 'function' ? value.bind(t) : value;
  },
});
export default function longnode(ctx) {
  const syncFs = wrap(ctx.sync.fs, { readFile: (path, ...rest) => long(path, ctx.sync.fs.readFile(path, ...rest)) });
  const fs = wrap(ctx.fs, { readFile: async (path, ...rest) => long(path, await ctx.fs.readFile(path, ...rest)) });
  const sync = wrap(ctx.sync, { fs: syncFs });
  return __main(new Proxy({}, { get: (_, key) => (key === 'sync' ? sync : key === 'fs' ? fs : ctx[key]), has: (_, key) => key in ctx }));
}
`
      )
    );
  });
  after(() => jsh?.close());

  it("is ERR_STRING_TOO_LONG from readFileSync and fs.readFile, and RangeError from the promise forms, as Node 22's", async () => {
    await jsh.kernel.writeFile(
      '/os/long.js',
      [
        "const fs = require('fs');",
        "fs.writeFileSync('long.txt', 'stand-in');",
        'const show = (label) => (e) => console.log(label, e ? `${e.name} ${e.code} ${e.message}` : "read");',
        '(async () => {',
        "  try { fs.readFileSync('long.txt', 'utf8'); show('readFileSync utf8')(); } catch (e) { show('readFileSync utf8')(e); }",
        "  await new Promise((r) => fs.readFile('long.txt', 'utf8', (e) => r(show('readFile utf8')(e))));",
        "  await fs.promises.readFile('long.txt', 'utf8').then(() => show('promises.readFile utf8')(), show('promises.readFile utf8'));",
        '})();',
      ].join('\n')
    );
    const r = await jsh.run(['longnode', 'long.js']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    const long = 'Error ERR_STRING_TOO_LONG Cannot create a string longer than 0x1fffffe8 characters';
    assert.deepEqual(r.stdout.trimEnd().split('\n'), [
      `readFileSync utf8 ${long}`,
      `readFile utf8 ${long}`,
      'promises.readFile utf8 RangeError undefined Invalid string length',
    ]);
  });
});
