import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { devPackageTree, kernelAtLeast, kernelVersion, lockedPackageTree, withJsh } from './helpers.mjs';

// The real unrs-resolver on its wasm32-wasi binding (jsh has no native one),
// as jest 30 and eslint-import-resolver use it. Its sync way runs on
// node:wasi in the program's thread (jest.test.mjs); its async way runs
// napi-rs's async work on Worker threads, each with its own node:wasi over
// the shared WebAssembly.Memory that it posts them, and globals the worker
// script assigns (require, Worker, postMessage): writable from slicc-kernel
// 1.135.4 (ai-ecoverse/slicc-kernel#1209).
const THREAD_KERNEL = '1.135.4';
describe('unrs-resolver on WASI worker threads (kernel)', { skip: !kernelAtLeast(THREAD_KERNEL) && `slicc-kernel ${kernelVersion} has no writable worker globals (${THREAD_KERNEL})` }, () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    for (const [path, data] of devPackageTree('unrs-resolver')) await jsh.kernel.writeFile(path, data);
    // npm skips that binding for this platform: it comes from the lockfile.
    for (const [path, data] of lockedPackageTree('@unrs/resolver-binding-wasm32-wasi')) await jsh.kernel.writeFile(path, data);
    await jsh.kernel.writeFile('/os/proj/package.json', JSON.stringify({ name: 'proj', private: true }));
    await jsh.kernel.writeFile('/os/proj/src/a.js', 'module.exports = 1;\n');
    await jsh.kernel.writeFile('/os/proj/node_modules/dep/package.json', JSON.stringify({ name: 'dep', main: 'lib/main.js' }));
    await jsh.kernel.writeFile('/os/proj/node_modules/dep/lib/main.js', 'module.exports = 2;\n');
    await jsh.kernel.writeFile(
      '/os/proj/resolve.js',
      `const threads = require('node:worker_threads');
// The Workers napi-rs makes for its async work, counted.
let workers = 0;
const NodeWorker = threads.Worker;
threads.Worker = class extends NodeWorker {
  constructor(...args) {
    super(...args);
    workers += 1;
  }
};
const { ResolverFactory } = require('unrs-resolver');
const resolver = new ResolverFactory({ extensions: ['.js'] });
const show = (r) => r.error ?? r.path;
console.log('sync:', show(resolver.sync('/os/proj', './src/a')), show(resolver.sync('/os/proj', 'dep')));
Promise.all([resolver.async('/os/proj', './src/a'), resolver.async('/os/proj', 'dep'), resolver.async('/os/proj', './nope')]).then((all) => {
  console.log('async:', all.map(show).join(' '));
  console.log('worker threads:', workers > 0);
});
`
    );
  });
  after(() => jsh?.close());

  it('resolves the async way on its worker threads, as the sync way does, and the program ends', async () => {
    const r = await jsh.run(['node', '--no-warnings', '/os/proj/resolve.js'], { cwd: '/os/proj' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout,
      "sync: /os/proj/src/a.js /os/proj/node_modules/dep/lib/main.js\nasync: /os/proj/src/a.js /os/proj/node_modules/dep/lib/main.js Cannot find module './nope'\nworker threads: true\n"
    );
  });
});
