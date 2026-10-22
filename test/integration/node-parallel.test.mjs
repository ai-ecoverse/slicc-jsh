import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runNode } from './run-script.mjs';

const KNOWN = {
  'test-assert-fail.js': 'does not end within the 20 s limit',
  'test-assert.js': 'assert.notEqual is not a function at test-assert.js:61',
  'test-buffer-alloc.js': 'the deprecated buffer.offset is undefined',
  'test-buffer-fill.js': 'no internal/test/binding',
  'test-buffer-from.js': 'Buffer.from of an object with Symbol.toPrimitive throws ERR_INVALID_ARG_TYPE',
  'test-fs-open-flags.js': 'no internal stringToFlags',
  'test-fs-read-stream.js': "test/fixtures/elipses.txt from Node's tree is not vendored",
  'test-stream-readable-async-iterators.js': 'an AssertionError in the async iterator cases',
};

const SKIPPED = {
  'test-path-win32-normalize-device-names.js': "Windows only: Node's own common.skip",
  'test-util-styletext.js': "needs a TTY: Node's own common.skip",
};

test("a slice of Node v22.22.0's test/parallel with Node's test/common: every file passes but the known gaps", { timeout: 600_000 }, async (t) => {
  const { status, out } = await runNode(t, ['test/node-parallel/run.mjs']);
  assert.equal(status, 0, out);
  const totals = /^totals: PASS=(\d+) FAIL=(\d+) SKIP=(\d+) of (\d+)$/m.exec(out);
  assert.ok(totals, out);
  const rows = [...out.matchAll(/^ {2}(PASS|FAIL|SKIP) (test-\S+)/gm)].map(([, verdict, file]) => ({ verdict, file }));
  assert.equal(rows.length, Number(totals[4]), out);
  assert.ok(rows.filter((r) => r.verdict === 'PASS').length > 0, out);
  const fail = rows.filter((r) => r.verdict === 'FAIL' && !KNOWN[r.file]).map((r) => r.file);
  const skip = rows.filter((r) => r.verdict === 'SKIP' && !SKIPPED[r.file]).map((r) => r.file);
  assert.deepEqual({ fail, skip }, { fail: [], skip: [] }, out);
});
