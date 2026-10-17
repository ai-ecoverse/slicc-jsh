import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devPackageTree, withJsh } from './helpers.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const version = (name) => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

// The golden async-local-storage-node22 pins where the store is carried as
// in Node. Here is the gap, which is jsh's own: a native await continuation
// resumes outside every run. It must fail safe, never seeing another run's store.
describe('AsyncLocalStorage (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  it("after a native await a run's store is missing (undefined), never another run's", async () => {
    await jsh.kernel.writeFile(
      '/os/als-await.js',
      `const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seen = [];
const request = (id, first, second) => als.run({ id }, async () => {
  seen.push(id + ' before await: ' + als.getStore()?.id);
  // A reaction registered in the run keeps it, even when it runs after another's.
  sleep(second).then(() => seen.push(id + ' then in run: ' + als.getStore()?.id));
  await sleep(first);
  seen.push(id + ' after await: ' + als.getStore()?.id);
  await null;
  seen.push(id + ' after await null: ' + als.getStore()?.id);
});
// Interleaved: B's continuation runs while A's later steps are pending, and back.
Promise.all([request('A', 5, 1), request('B', 1, 8), als.run({ id: 'C' }, () => sleep(3).then(() => seen.push('C then: ' + als.getStore()?.id)))]).then(() => {
  setTimeout(() => {
    seen.push('outside: ' + als.getStore());
    for (const line of seen) console.log(line);
  }, 20);
});
`
    );
    const r = await jsh.run(['node', 'als-await.js']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    const lines = r.stdout.trim().split('\n');
    // Before an await the store is the run's; every line after one is undefined.
    assert.deepEqual(lines.filter((l) => l.includes('before await')).sort(), ['A before await: A', 'B before await: B']);
    assert.deepEqual(
      lines.filter((l) => l.includes('after await')).sort(),
      ['A after await null: undefined', 'A after await: undefined', 'B after await null: undefined', 'B after await: undefined']
    );
    // Reactions registered inside a run carry that run's store, and only it.
    assert.deepEqual(lines.filter((l) => l.includes('then')).sort(), ['A then in run: A', 'B then in run: B', 'C then: C']);
    assert.equal(lines.at(-1), 'outside: undefined');
  });

  it('enterWith after a native await throws ERR_NOT_SUPPORTED rather than reach unrelated code', async () => {
    const r = await jsh.run([
      'node',
      '-e',
      `const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
als.enterWith('main');
console.log('main', als.getStore());
setTimeout(() => {
  console.log('timer made in main', als.getStore());
  als.enterWith('in timer');
  console.log('timer', als.getStore());
}, 1);
setTimeout(() => console.log('next timer', als.getStore()), 5);
(async () => {
  await null;
  console.log('after await', als.getStore());
  try { als.enterWith('after await'); } catch (e) { console.log(e.code, e.message); }
  console.log('still', als.getStore());
})();
`,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.split('\n'), [
      'main main',
      'after await undefined',
      "ERR_NOT_SUPPORTED slicc-jsh: AsyncLocalStorage#enterWith is not supported here yet (after a native await, or in a callback of the runtime's own I/O, its store would reach unrelated code); use run()",
      'still undefined',
      'timer made in main main',
      'timer in timer',
      'next timer main',
      '',
    ]);
  });

  it('the real playwright-core loads (it makes an AsyncLocalStorage at load) and its request context GETs a loopback server', async () => {
    assert.equal(version('playwright-core'), '1.64.1');
    for (const [path, data] of devPackageTree('playwright-core')) await jsh.kernel.writeFile(`/os${path}`, data);
    await jsh.kernel.writeFile(
      '/os/pw.js',
      `const http = require('http');
const { request } = require('playwright-core');
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ method: req.method, url: req.url }));
});
server.listen(0, '127.0.0.1', async () => {
  try {
    const context = await request.newContext({ baseURL: 'http://127.0.0.1:' + server.address().port });
    const res = await context.get('/hello?x=1');
    console.log('get', res.status(), JSON.stringify(await res.json()));
    const post = await context.post('/form', { data: { a: 1 } });
    console.log('post', post.status(), JSON.stringify(await post.json()));
    await context.dispose();
  } catch (e) {
    console.log('error', e.message.split('\\n')[0]);
  }
  server.close();
});
`
    );
    const r = await jsh.run(['node', 'pw.js']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.deepEqual(r.stdout.split('\n'), [
      'get 200 {"method":"GET","url":"/hello?x=1"}',
      'post 200 {"method":"POST","url":"/form"}',
      '',
    ]);
  });
});
