import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runNode } from './run-script.mjs';

test('the differential cases in test/integration/cert: host Node 22.22.0 and the kernel node, with the kernel loaded from a plain dist path', { timeout: 600_000 }, async (t) => {
  const { status, out } = await runNode(t, ['test/integration/cert/run.mjs']);
  assert.equal(status, 0, out);
  assert.match(out, /^cert: 4 suite\(s\), [1-9]\d* case\(s\), failed=0$/m, out);
  for (const [, suite, total, same, diff, failed] of out.matchAll(/^cert\[(\S+)\]: (\d+) case\(s\), SAME=(\d+), DIFF=(\d+), failed=(\d+)$/gm)) {
    assert.ok(Number(total) > 0, suite);
    assert.equal(Number(same) + Number(diff), Number(total), suite);
    assert.equal(Number(failed), 0, suite);
  }
});
