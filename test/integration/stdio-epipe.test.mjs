import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJshAndSh } from './helpers.mjs';

// Node ignores SIGPIPE: a write to a pipe whose reader is gone fails with
// EPIPE. process.stdout's 'error' then ends the program (status 1, after its
// 'exit' listeners) where nothing handles it. console swallows the first one
// only: stdout is undestroyed (Node's dummyDestroy), so the next write's
// error ends it too. Removing the last SIGPIPE listener restores the default
// action: the program dies of the signal (141), as Node's does.
describe('stdout to a closed pipe (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJshAndSh();
  });
  after(() => jsh?.close());
  const sh = (script) => jsh.run(['sh', '-c', script]);
  const writer = (expr) =>
    `node -e 'process.on("exit", (c) => console.error("exit", c)); let i = 0; const t = setInterval(() => { ${expr}; if (++i > 300) clearInterval(t); }, 2)' | { read l; echo "got $l"; }; echo "status \${PIPESTATUS[0]}"`;

  it('process.stdout.write: an EPIPE error, status 1, no SIGPIPE death', async () => {
    const r = await sh(writer('process.stdout.write("x\\n")'));
    assert.match(r.stdout, /^got x\nstatus 1\n$/);
    assert.match(r.stderr, /^exit 1\n/);
    assert.match(r.stderr, /Error: write EPIPE\n[\s\S]*errno: -32,\n {2}code: 'EPIPE',\n {2}syscall: 'write'/);
  });

  it('console.log: the first error is swallowed, the next one ends the program (status 1)', async () => {
    const r = await sh(writer('console.log("c")'));
    assert.equal(r.stdout, 'got c\nstatus 1\n');
    assert.match(r.stderr, /^exit 1\n/);
    assert.match(r.stderr, /Error: write EPIPE\n/);
  });

  it('stdout keeps emitting: one error per failed write, after the first is handled (dummyDestroy)', async () => {
    const r = await sh(
      `node -e 'let n = 0; process.stdout.on("error", (e) => { if (++n === 3) { console.error("errors", n, e.code, process.stdout.destroyed); process.exit(3); } }); setInterval(() => process.stdout.write("x\\n"), 2)' | { read l; }; echo "status \${PIPESTATUS[0]}"`
    );
    assert.equal(r.stdout, 'status 3\n');
    assert.equal(r.stderr, 'errors 3 EPIPE false\n');
  });

  it('removing the last SIGPIPE listener restores its default: death by SIGPIPE (141)', async () => {
    const r = await sh(
      `node -e 'process.on("SIGPIPE", () => {}); process.removeAllListeners("SIGPIPE"); process.stdout.on("error", (e) => { console.error("error", e.code); process.exit(3); }); setInterval(() => process.stdout.write("x\\n"), 2)' | { read l; }; echo "status \${PIPESTATUS[0]}"`
    );
    assert.equal(r.stdout, 'status 141\n');
    assert.equal(r.stderr, '');
  });
});
