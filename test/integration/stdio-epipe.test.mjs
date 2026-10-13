import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJshAndSh } from './helpers.mjs';

// Node ignores SIGPIPE: a write to a pipe whose reader is gone fails with
// EPIPE. process.stdout's 'error' then ends the program (status 1, after its
// 'exit' listeners) where nothing handles it; console swallows it.
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

  it('console.log: the error is swallowed, the program ends normally', async () => {
    const r = await sh(writer('console.log("c")'));
    assert.equal(r.stdout, 'got c\nstatus 0\n');
    assert.equal(r.stderr, 'exit 0\n');
  });

  it('a SIGPIPE listener catches it; removing it leaves SIGPIPE ignored', async () => {
    const r = await sh(
      `node -e 'process.on("SIGPIPE", () => {}); process.removeAllListeners("SIGPIPE"); process.stdout.on("error", (e) => { console.error("error", e.code); process.exit(3); }); setInterval(() => process.stdout.write("x\\n"), 2)' | { read l; }; echo "status \${PIPESTATUS[0]}"`
    );
    assert.equal(r.stdout, 'status 3\n');
    assert.equal(r.stderr, 'error EPIPE\n');
  });
});
