/**
 * process.memoryUsage() reports what jsh measures and 0 for what nothing in
 * its process worker can measure (#397): `arrayBuffers` counts the live
 * Buffers jsh allocated, `external`
 * includes them, and `rss()` is `memoryUsage().rss`. Heap figures need the
 * kernel's ctx.memory(); until a kernel has it they are 0 together, never
 * an estimate. The shape is host Node's.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

const MiB = 1024 * 1024;

describe('process.memoryUsage (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());
  const json = async (code) => {
    const r = await jsh.run(['node', '-e', code]);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };

  it("has host Node's keys, types and invariants, and rss() is memoryUsage().rss", async () => {
    const m = await json(
      'const m = process.memoryUsage(); console.log(JSON.stringify({ m, rss: process.memoryUsage.rss(), rssType: typeof process.memoryUsage.rss() }))'
    );
    const host = process.memoryUsage();
    assert.deepEqual(Object.keys(m.m), Object.keys(host));
    for (const [k, v] of Object.entries(m.m)) assert.ok(Number.isFinite(v) && v >= 0, `${k}: ${v}`);
    assert.ok(m.m.heapUsed <= m.m.heapTotal);
    assert.ok(m.m.arrayBuffers <= m.m.external);
    assert.equal(m.rssType, typeof process.memoryUsage.rss());
    assert.equal(m.rss, m.m.rss);
  });

  it('arrayBuffers and external grow by a Buffer jsh allocates, and views add nothing', async () => {
    const m = await json(`
      const before = process.memoryUsage();
      const big = Buffer.alloc(${64 * MiB}, 1);
      const views = [big.subarray(1), big.slice(2), Buffer.from(big.buffer), Buffer.from(big.buffer, 8, 16)];
      const after = process.memoryUsage();
      console.log(JSON.stringify({ before, after, kept: big.length + views.length }));
    `);
    const grew = m.after.arrayBuffers - m.before.arrayBuffers;
    assert.ok(grew >= 64 * MiB && grew < 65 * MiB, `arrayBuffers grew by ${grew}`);
    assert.ok(m.after.external - m.before.external >= 64 * MiB);
  });

  it('a Buffer whose memory was transferred away counts nothing', async () => {
    const m = await json(`
      const big = Buffer.alloc(${64 * MiB});
      const held = process.memoryUsage().arrayBuffers;
      const moved = structuredClone(big.buffer, { transfer: [big.buffer] });
      console.log(JSON.stringify({ held, after: process.memoryUsage().arrayBuffers, detached: big.buffer.byteLength, moved: moved.byteLength }));
    `);
    assert.equal(m.detached, 0);
    assert.equal(m.moved, 64 * MiB);
    assert.ok(m.held - m.after >= 64 * MiB, `${m.held} -> ${m.after}`);
  });

  it('heap figures are measured or both 0, never one without the other', async (t) => {
    const m = await json(`
      const before = process.memoryUsage();
      const keep = Array.from({ length: 1e6 }, (_, i) => ({ i, s: 'x' + i }));
      const after = process.memoryUsage();
      console.log(JSON.stringify({ before, after, n: keep.length }));
    `);
    if (m.after.heapTotal === 0) {
      assert.equal(m.after.heapUsed, 0);
      assert.equal(m.before.heapUsed, 0);
      t.skip('this kernel measures no heap for a JS program (no ctx.memory)');
      return;
    }
    assert.ok(m.after.heapUsed > m.before.heapUsed, `${m.before.heapUsed} -> ${m.after.heapUsed}`);
  });
});
