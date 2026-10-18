import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { progressRun } from '../../scripts/cert-review/lib.mjs';

const kernel = (script) => ({
  run: (argv, { onStdout, onStderr }) =>
    new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let i = 0;
      const step = () => {
        const next = script[i++];
        if (!next) return resolve({ status: 0, stdout, stderr });
        if (next.end) return;
        setTimeout(() => {
          if (next.out) {
            stdout += next.out;
            onStdout(next.out);
          }
          if (next.err) {
            stderr += next.err;
            onStderr(next.err);
          }
          step();
        }, next.after);
      };
      step();
    }),
});

describe("the m-fixtures' case runner fails a case on no progress, not at a fixed time", () => {
  it('a case that keeps printing runs past the quiet bound and ends on its own', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({ after: 150, out: `pkg ${i}\n` }));
    const started = Date.now();
    const r = await progressRun(kernel(lines), ['node', 'use.mjs'], {}, { quiet: 500, outer: 30_000 });
    assert.ok(Date.now() - started >= 1400, 'it ran for longer than the quiet bound');
    assert.deepEqual(r, { status: 0, stdout: lines.map((l) => l.out).join(''), stderr: '' });
  });

  it('a case that goes quiet is a TIMEOUT that names how long it ran and what it last printed', async () => {
    const r = await progressRun(kernel([{ after: 50, out: 'date-fns 10\n' }, { after: 50, err: 'warn\n' }, { end: true }]), ['node', 'use.mjs'], {}, { quiet: 400, outer: 30_000 });
    assert.equal(r.status, 'TIMEOUT');
    assert.equal(r.stdout, 'date-fns 10\n');
    assert.equal(r.stderr, 'warn\n');
    assert.match(r.why, /^no output for 0\.4 s after [01] s; it last printed "date-fns 10\\nwarn\\n"$/);
  });

  it('a case that prints nothing at all is a TIMEOUT that says so', async () => {
    const r = await progressRun(kernel([{ end: true }]), ['node', 'quiet.js'], {}, { quiet: 300, outer: 30_000 });
    assert.equal(r.status, 'TIMEOUT');
    assert.match(r.why, /^no output for 0\.3 s after [01] s; it printed nothing$/);
  });

  it('a case that never stops printing ends at the outer bound', async () => {
    const forever = Array.from({ length: 1000 }, () => ({ after: 50, out: '.' }));
    const r = await progressRun(kernel(forever), ['node', 'spin.js'], {}, { quiet: 1000, outer: 800 });
    assert.equal(r.status, 'TIMEOUT');
    assert.match(r.why, /^still running after [01] s; it last printed "\.+"$/);
  });

  it("a kernel run that throws is the case's ERROR, with what it printed", async () => {
    const k = { run: (argv, { onStdout }) => (onStdout('half'), Promise.reject(new Error('terminated'))) };
    const r = await progressRun(k, ['node', 'x.js'], {}, { quiet: 1000, outer: 5000 });
    assert.deepEqual(r, { status: 'ERROR terminated', stdout: 'half', stderr: '' });
  });
});
