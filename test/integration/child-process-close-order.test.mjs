import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

describe("child_process 'close' comes after the child's stdio closes, as in Node", () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  const run = async (script) => {
    await jsh.kernel.writeFile('/os/close-order.js', script);
    return jsh.run(['node', 'close-order.js'], { cwd: '/os' });
  };

  it("a reader that pauses gets every byte and 'end' before 'close'", async () => {
    const r = await run(
      [
        "const cp = require('child_process');",
        "const c = cp.spawn(process.execPath, ['-e', \"process.stdout.write('x'.repeat(200000) + 'END', () => process.exit(3))\"]);",
        "let n = 0; let ended = false; let paused = false;",
        "c.stdout.on('data', (b) => { n += b.length; if (!paused) { paused = true; c.stdout.pause(); setTimeout(() => c.stdout.resume(), 50); } });",
        "c.stdout.on('end', () => { ended = true; });",
        "c.on('close', (code) => console.log(n, ended, code));",
        '',
      ].join('\n')
    );
    assert.equal(r.stdout, '200003 true 3\n', r.stderr);
  });

  it("a child's last line before it exits from a signal handler comes before 'close'", async () => {
    const r = await run(
      [
        "const cp = require('child_process');",
        "const d = cp.spawn(process.execPath, ['-e', 'process.on(\"SIGUSR2\", () => { console.log(\"child got USR2\"); process.exit(7) }); setInterval(() => {}, 1000); console.log(\"ready\")']);",
        "d.stdout.on('data', (b) => { for (const t of String(b).trim().split('\\n')) { console.log('child says', t); if (t === 'ready') process.kill(d.pid, 'SIGUSR2'); } });",
        "d.stdout.on('end', () => d.stdout.pause());",
        "d.on('close', (code, sig) => console.log('handler child exit', code, sig));",
        '',
      ].join('\n')
    );
    assert.equal(r.stdout, 'child says ready\nchild says child got USR2\nhandler child exit 7 null\n', r.stderr);
  });

  it("stdout nobody reads is drained, so 'close' still comes", async () => {
    const r = await run(
      [
        "const cp = require('child_process');",
        "const c = cp.spawn(process.execPath, ['-e', \"process.stdout.write('y'.repeat(4096))\"]);",
        "c.on('close', (code) => console.log('close', code, c.stdout.readableEnded));",
        '',
      ].join('\n')
    );
    assert.equal(r.stdout, 'close 0 true\n', r.stderr);
  });
});
