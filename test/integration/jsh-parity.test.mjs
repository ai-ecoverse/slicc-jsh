import assert from 'node:assert/strict';
import { test } from 'node:test';
import { caseDirs, runNode } from './run-script.mjs';

test('every .jsh case in test/jsh/fixtures gives the host jsh on Node 22.22.0 and the kernel jsh the same stdout, stderr and status', { timeout: 600_000 }, async (t) => {
  const names = caseDirs('test/jsh/fixtures');
  assert.ok(names.length > 0);
  const { status, out } = await runNode(t, ['scripts/jsh-golden.mjs', 'check']);
  assert.equal(status, 0, out);
  assert.match(out, new RegExp(`^jsh check: ${names.length} case\\(s\\)$`, 'm'), out);
  const ok = new Set(out.match(/^ok \S+$/gm)?.map((line) => line.slice(3)));
  assert.deepEqual(names.filter((name) => !ok.has(name)), [], out);
  for (const skip of out.match(/^skip \S+ \[kernel\]: .*$/gm) ?? []) assert.doesNotMatch(skip, /: kernel: false$/, out);
});
