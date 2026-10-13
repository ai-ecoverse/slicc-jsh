import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

// Node's own lib files (src/node-lib) are evaluated once per realm and keep
// module state (the global console's counters, util's Buffer check). Every
// program gets a realm of its own, so none of it leaks between runs.
describe('node-lib state per program (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  it('two programs in one kernel: console.count, util.isBuffer, NODE_DEBUG are each their own', async () => {
    const code =
      "console.count('x'); console.log(require('util').isBuffer(Buffer.from('x')), require('util').debuglog('t').enabled, globalThis.__seen = (globalThis.__seen ?? 0) + 1)";
    const a = await jsh.run(['node', '-e', code]);
    const b = await jsh.run(['node', '-e', code], { env: { NODE_DEBUG: 't' } });
    assert.equal(a.stdout, 'x: 1\ntrue false 1\n');
    assert.equal(b.stdout, 'x: 1\ntrue true 1\n');
  });
});
