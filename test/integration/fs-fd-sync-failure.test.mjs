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
