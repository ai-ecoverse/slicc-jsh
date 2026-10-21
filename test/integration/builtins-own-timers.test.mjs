import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';
import { createChildProcess } from '../../src/runtime/builtins/child-process.mjs';

const script = `const crypto = require('crypto');
const zlib = require('zlib');
for (const name of ['setImmediate', 'setTimeout', 'setInterval', 'clearImmediate', 'clearTimeout', 'clearInterval']) {
  globalThis[name] = undefined;
  require('timers')[name] = undefined;
}
const later = (name, call) => new Promise((resolve) => {
  let sync = true;
  call((err) => {
    console.log(name, err?.code, sync ? 'sync' : 'later');
    resolve();
  });
  sync = false;
});
const cases = {
  generateKeyPair: (cb) => crypto.generateKeyPair('rsa', { modulusLength: 512 }, cb),
  generatePrime: (cb) => crypto.generatePrime(8, cb),
  checkPrime: (cb) => crypto.checkPrime(Buffer.from([7]), cb),
  brotliCompress: (cb) => zlib.brotliCompress('x', cb),
  zstdCompress: (cb) => zlib.zstdCompress('x', cb),
};
later(process.argv[2], cases[process.argv[2]]);
process.on('exit', () => console.log('the program ends'));
`;

describe('builtins without the global timers: what jsh has no Node output for (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    await jsh.kernel.writeFile('/os/unavailable.js', script);
  });
  after(() => jsh?.close());

  for (const name of ['generateKeyPair', 'generatePrime', 'checkPrime', 'brotliCompress', 'zstdCompress']) {
    it(`${name}: its callback form reports on a later turn, on jsh's own setImmediate`, async () => {
      const r = await jsh.run(['node', 'unavailable.js', name]);
      assert.equal(r.stderr, '');
      assert.equal(r.status, 0);
      const code = name.endsWith('Compress') ? undefined : 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM';
      assert.equal(r.stdout, `${name} ${code} later\nthe program ends\n`);
    });
  }
});

describe('child_process without the global setImmediate: a kernel without ctx.sync.spawn', () => {
  it("a failed spawn's close waits for the spawns still in flight, on jsh's own setImmediate", async () => {
    const own = { setImmediate, setTimeout, clearTimeout };
    let settle;
    const second = new Promise((resolve) => {
      settle = resolve;
    });
    let spawned = 0;
    const enoent = () => Object.assign(new Error('not found'), { code: 'ENOENT' });
    const cp = createChildProcess({
      ctx: {
        sync: {
          fs: {
            stat: (p) => {
              if (p === '/') return { isDirectory: true };
              throw enoent();
            },
          },
        },
        spawn: () => (++spawned === 1 ? Promise.reject(enoent()) : second.then(() => Promise.reject(enoent()))),
      },
      process: { cwd: () => '/', env: {}, nextTick: (fn, ...args) => process.nextTick(fn, ...args) },
      Buffer,
      handles: { add() {}, delete() {}, notify() {} },
      getStream: () => {
        throw new Error('not reached');
      },
      timers: own,
    });
    const events = [];
    const saved = globalThis.setImmediate;
    globalThis.setImmediate = undefined;
    try {
      const closed = (name) =>
        new Promise((resolve) =>
          cp
            .spawn(name, [], { stdio: 'ignore' })
            .on('error', (err) => events.push(`${name} error ${err.code}`))
            .on('close', (code) => {
              events.push(`${name} close ${code}`);
              resolve();
            })
        );
      const first = closed('a');
      const next = closed('b');
      await new Promise((resolve) => own.setTimeout(resolve, 20));
      assert.deepEqual(events, ['a error ENOENT']);
      settle();
      await Promise.all([first, next]);
    } finally {
      globalThis.setImmediate = saved;
    }
    assert.deepEqual(events, ['a error ENOENT', 'b error ENOENT', 'a close -2', 'b close -2']);
  });
});
