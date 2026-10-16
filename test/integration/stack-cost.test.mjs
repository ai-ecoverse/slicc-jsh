import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

// The kernel imports the runtime from a data: URL of the whole bundle (MBs),
// so each of the runtime's own frames in a stack has a file name, and a text,
// that long. Formatting a stack dropped those frames only after formatting
// and regex-scanning each one's text: a few milliseconds per stack, so Node's
// test/common (a stack per mustCall / mustNotCall) made
// test-event-emitter-check-listener-leaks.js take 16-20 s on the bench, where
// Node takes well under a second (ai-ecoverse/slicc-jsh#234, #235).
//
// Host Node 22 does each loop below in about 5 ms. Before the fix jsh took
// 1.2 s, 1.4 s and 3.2 s for them on a laptop (about 3x that on the bench);
// after it, 8, 7 and 10 ms. (A first version of the fix still read a
// builtin frame's eval origin, which copies the whole URL: 66 ms here, 1.8 s
// on CI.)
const N = 1000;
const BOUND_MS = 500;

describe('stack capture cost (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  const timedLoop = async (body) => {
    const r = await jsh.run([
      'node',
      '-e',
      `const util = require('util'); const t = Date.now(); for (let i = 0; i < ${N}; i++) { ${body} } console.log(Date.now() - t);`,
    ]);
    assert.equal(r.status, 0, r.stderr);
    return Number(r.stdout.trim());
  };

  it("reading an error's stack does not scan the runtime's own frames", async () => {
    const ms = await timedLoop('new Error(String(i)).stack;');
    assert.ok(ms < BOUND_MS, `${N} stacks took ${ms} ms`);
  });

  it("a user prepareStackTrace (test/common's getCallSite) does not either", async () => {
    const ms = await timedLoop(
      "const p = Error.prepareStackTrace; Error.prepareStackTrace = (e, s) => `${s[0].getFileName()}:${s[0].getLineNumber()}`; const e = {}; Error.captureStackTrace(e); e.stack; Error.prepareStackTrace = p;"
    );
    assert.ok(ms < BOUND_MS, `${N} stacks took ${ms} ms`);
  });

  it("util.getCallSites does not scan a builtin's frames (no file; its eval origin is the bundle's URL)", async () => {
    const ms = await timedLoop('util.getCallSites();');
    assert.ok(ms < BOUND_MS, `${N} getCallSites took ${ms} ms`);
  });

  it('the stack still names the program\'s frames and none of the runtime\'s', async () => {
    const r = await jsh.run(['node', '-e', 'function f() { return new Error("x").stack; } console.log(f());']);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines[0], 'Error: x');
    assert.match(lines[1], /^ {4}at f \(\[eval\]:1:/);
    assert.ok(!r.stdout.includes('data:'), r.stdout);
  });
});
