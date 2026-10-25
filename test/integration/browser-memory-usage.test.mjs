import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { launch } from '../browser/chrome.mjs';
import { booted, installJsh, packJsh } from '../browser/kernel.mjs';

const MiB = 1024 * 1024;
const pack = mkdtempSync(join(tmpdir(), 'jsh-memory-usage-pack-'));
let chrome;
let tgz;

before(async () => {
  tgz = packJsh(pack);
  chrome = await launch({ pack: `${pack}/` });
}, { timeout: 900_000 });

after(async () => {
  await chrome?.close();
  rmSync(pack, { recursive: true, force: true });
});

test("process.memoryUsage() in the browser: Node's keys, rss 0, heap figures from performance.memory or both 0, and the Buffers jsh allocates", { timeout: 900_000 }, async (t) => {
  const k = await booted(chrome, t, { cdp: false });
  await installJsh(k, chrome, tgz);
  const r = await k.run([
    'node',
    '-e',
    `const before = process.memoryUsage();
const big = Buffer.alloc(${64 * MiB}, 1);
const views = [big.subarray(1), big.slice(2), Buffer.from(big.buffer), Buffer.from(big.buffer, 8, 16)];
const after = process.memoryUsage();
console.log(JSON.stringify({ before, after, rss: process.memoryUsage.rss(), perf: typeof performance.memory, kept: big.length + views.length }));`,
  ]);
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(r.stdout);
  for (const usage of [m.before, m.after]) {
    assert.deepEqual(Object.keys(usage), Object.keys(process.memoryUsage()));
    for (const [key, value] of Object.entries(usage)) assert.ok(Number.isFinite(value) && value >= 0, `${key}: ${value}`);
    assert.equal(usage.rss, 0);
    if (m.perf === 'undefined') assert.deepEqual([usage.heapTotal, usage.heapUsed], [0, 0]);
    else assert.ok(usage.heapUsed > 0 && usage.heapUsed <= usage.heapTotal, JSON.stringify(usage));
    assert.ok(usage.external >= usage.arrayBuffers, JSON.stringify(usage));
  }
  assert.equal(m.rss, 0);
  const grew = m.after.arrayBuffers - m.before.arrayBuffers;
  assert.ok(grew >= 64 * MiB && grew < 65 * MiB, `arrayBuffers grew by ${grew}`);
  assert.deepEqual(k.page.errors, []);
});
