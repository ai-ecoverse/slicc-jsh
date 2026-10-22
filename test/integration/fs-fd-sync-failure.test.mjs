import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh, wrapCommandMain } from './helpers.mjs';

describe('a held descriptor whose sync fails (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    await jsh.kernel.writeFile(
      '/node_modules/syncfailnode/package.json',
      JSON.stringify({ name: 'syncfailnode', version: '1.0.0', type: 'module', slicc: { commands: { syncfailnode: { abi: 'js', module: 'index.mjs' } } } })
    );
    await jsh.kernel.writeFile(
      '/node_modules/syncfailnode/index.mjs',
      wrapCommandMain(
        'node',
        `export default function syncfailnode(ctx) {
  const real = ctx.sync;
  let failures = 0;
  const open = (path, options) => {
    const file = real.open(path, options);
    if (!options?.write) return file;
    return new Proxy(file, {
      get(target, key) {
        if (key === 'sync') {
          return () => {
            if (failures++ % 2 === 0) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
            return target.sync();
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  const sync = new Proxy(real, {
    get(target, key) {
      if (key === 'open') return open;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return __main(new Proxy({}, { get: (_, key) => (key === 'sync' ? sync : ctx[key]), has: (_, key) => key in ctx }));
}
`
      )
    );
  });
  after(() => jsh?.close());

  it("the write still moves the position past what was stored, and its error is Node's", async () => {
    await jsh.kernel.writeFile(
      '/os/syncfail.js',
      `const fs = require('fs');
fs.writeFileSync('s.txt', '........');
const fd = fs.openSync('s.txt', 'r+');
const tryIt = (label, fn) => {
  try {
    fn();
    console.log(label, 'ok');
  } catch (e) {
    console.log(label, e.code, e.errno, e.syscall, 'path' in e, e.message);
  }
};
tryIt('write AB', () => fs.writeSync(fd, 'AB'));
tryIt('write CD', () => fs.writeSync(fd, 'CD'));
tryIt('write EF', () => fs.writeSync(fd, 'EF'));
tryIt('ftruncate 5', () => fs.ftruncateSync(fd, 5));
fs.closeSync(fd);
console.log(JSON.stringify(fs.readFileSync('s.txt', 'utf8')));
`
    );
    const r = await jsh.run(['syncfailnode', 'syncfail.js']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.equal(
      r.stdout,
      [
        'write AB EIO -5 write false EIO: i/o error, write',
        'write CD ok',
        'write EF EIO -5 write false EIO: i/o error, write',
        'ftruncate 5 ok',
        '"ABCDE"',
        '',
      ].join('\n')
    );
  });
});

describe('a descriptor whose kernel open fails (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    await jsh.kernel.writeFile(
      '/node_modules/openfailnode/package.json',
      JSON.stringify({ name: 'openfailnode', version: '1.0.0', type: 'module', slicc: { commands: { openfailnode: { abi: 'js', module: 'index.mjs' } } } })
    );
    await jsh.kernel.writeFile(
      '/node_modules/openfailnode/index.mjs',
      wrapCommandMain(
        'node',
        `const fail = (code) => Object.assign(new Error(code + ': stand-in'), { code });
const wrap = (target, replace) => new Proxy(target, {
  get(t, key) {
    if (key in replace) return replace[key];
    const value = Reflect.get(t, key, t);
    return typeof value === 'function' ? value.bind(t) : value;
  },
});
export default function openfailnode(ctx) {
  const failed = new Set();
  const open = (path, options) => {
    const name = String(path).split('/').pop();
    if (name.startsWith('eio-') && !failed.has(name)) {
      failed.add(name);
      throw fail('EIO');
    }
    if (name.startsWith('eacces-')) throw fail('EACCES');
    return ctx.sync.open(path, options);
  };
  const readFile = (path, ...rest) => (globalThis.__kernelRead = ctx.sync.fs.readFile(path, ...rest));
  const sync = wrap(ctx.sync, { open, fs: wrap(ctx.sync.fs, { readFile }) });
  return __main(new Proxy({}, { get: (_, key) => (key === 'sync' ? sync : ctx[key]), has: (_, key) => key in ctx }));
}
`
      )
    );
  });
  after(() => jsh?.close());

  it('reads and writes by its path for an error other than a refusal, and a refusal is the open\'s', async () => {
    await jsh.kernel.writeFile(
      '/os/openfail.js',
      `const fs = require('fs');
fs.writeFileSync('eio-read.txt', 'abcdefghij');
const fd = fs.openSync('eio-read.txt', 'r');
fs.readSync(fd, Buffer.alloc(3), 0, 3, null);
const rest = fs.readFileSync(fd);
console.log('rest', rest.toString(), rest.byteOffset, rest.buffer.byteLength === rest.length, rest.buffer !== globalThis.__kernelRead.buffer);
fs.closeSync(fd);
const w = fs.openSync('eio-write.txt', 'w');
fs.writeSync(w, 'one');
fs.renameSync('eio-write.txt', 'eio-moved.txt');
fs.writeFileSync('eio-write.txt', '');
fs.writeSync(w, 'two');
fs.closeSync(w);
console.log('moved', JSON.stringify(fs.readFileSync('eio-moved.txt', 'latin1')), 'path', JSON.stringify(fs.readFileSync('eio-write.txt', 'latin1')));
fs.writeFileSync('own.txt', 'whole');
const whole = fs.readFileSync('own.txt');
console.log('whole', whole.toString(), whole.buffer === globalThis.__kernelRead.buffer);
fs.writeFileSync('eacces-r.txt', 'x');
for (const flags of ['r', 'w']) {
  try {
    fs.openSync('eacces-' + flags + '.txt', flags);
    console.log('opened', flags);
  } catch (e) {
    console.log('refused', flags, e.code, e.syscall, e.path);
  }
}
`
    );
    const r = await jsh.run(['openfailnode', 'openfail.js']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.equal(
      r.stdout,
      [
        'rest defghij 0 true true',
        'moved "one" path "\\u0000\\u0000\\u0000two"',
        'whole whole true',
        'refused r EACCES open eacces-r.txt',
        'refused w EACCES open eacces-w.txt',
        '',
      ].join('\n')
    );
  });
});

