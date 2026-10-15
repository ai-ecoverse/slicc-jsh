import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

// slicc-kernel 1.65's ctx.sync.exit: process.exit() (and so cli.die /
// cli.help, kill(self) without a handler) ends the program at once, as
// Node's does: no catch, finally, microtask or timer of the program runs
// after it. Older kernels unwind silently (the runtime feature-detects).
//
// What still ran while unwinding was already silenced, so these tests see it
// by time: a finally that spins for SPIN ms would make the run take that
// long; with sync.exit it never starts.
const SPIN = 2000;
const spin = `{ const t = Date.now(); while (Date.now() - t < ${SPIN}); }`;

describe('process.exit on ctx.sync.exit (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  const timed = async (argv) => {
    const t = Date.now();
    const r = await jsh.run(argv);
    return { ...r, ms: Date.now() - t };
  };

  it('no finally or catch runs after process.exit(); the exit listeners and earlier writes do', async () => {
    const r = await timed([
      'node',
      '-e',
      `process.on('exit', (c) => console.log('exit', c)); try { process.stdout.write('before '); process.exit(3); } catch ${spin} finally ${spin}`,
    ]);
    assert.equal(r.status, 3);
    assert.equal(r.stdout, 'before exit 3\n');
    assert.ok(r.ms < SPIN * 0.75, `took ${r.ms} ms`);
  });

  it('inside an async function: its finally never runs', async () => {
    const r = await timed(['node', '-e', `(async () => { try { await 1; process.exit(5); } finally ${spin} })()`]);
    assert.equal(r.status, 5);
    assert.ok(r.ms < SPIN * 0.75, `took ${r.ms} ms`);
  });

  it("a .jsh's cli.die ends at once too", async () => {
    await jsh.kernel.writeFile(
      '/os/die.jsh',
      `const cli = require('sliccy:cli');\ntry { cli.die('bad thing', 3); } finally ${spin}\n`
    );
    const r = await timed(['jsh', 'die.jsh']);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /bad thing/);
    assert.ok(r.ms < SPIN * 0.75, `took ${r.ms} ms`);
  });

  it('kill(self, SIGSTOP) stops the process; SIGCONT resumes it where it was (no exit)', async () => {
    await jsh.kernel.writeFile(
      '/os/self-stop.js',
      "console.log('before'); process.kill(process.pid, 'SIGSTOP'); setTimeout(() => console.log('resumed'), 50);"
    );
    const r = await jsh.run([
      'node',
      '-e',
      [
        "const c = require('child_process').spawn('node', ['/os/self-stop.js']);",
        // The child stops itself right after 'before' (one synchronous
        // call), so wait for that line rather than a fixed time: a slow
        // spawn would otherwise get SIGCONT before its SIGSTOP and stay
        // stopped, as on Linux.
        "let out = '';",
        "c.stdout.on('data', (d) => {",
        "  out += d;",
        "  if (out !== 'before\\n') return;",
        "  setTimeout(() => { console.log('stopped', c.exitCode === null, JSON.stringify(out)); c.kill('SIGCONT'); }, 200);",
        "});",
        "c.on('close', (code, sig) => console.log('closed', code, sig, JSON.stringify(out)));",
      ].join('\n'),
    ]);
    assert.equal(r.stdout, 'stopped true "before\\n"\nclosed 0 null "before\\nresumed\\n"\n');
  });

  it('kill(self) with no handler dies of the signal: its parent sees the signal, not a status', async () => {
    // The kernel delivers a JS program's default action on a turn of its
    // own, so the program unwinds first (silenced): ai-ecoverse/slicc-kernel#431.
    await jsh.kernel.writeFile('/os/self-kill.js', "process.on('exit', () => console.log('exit ran')); process.kill(process.pid, 'SIGTERM'); console.log('after');");
    const r = await jsh.run([
      'node',
      '-e',
      "const r = require('child_process').spawnSync('node', ['/os/self-kill.js']); console.log(JSON.stringify([r.status, r.signal, String(r.stdout)]))",
    ]);
    assert.equal(r.stdout, '[null,"SIGTERM",""]\n');
  });
});

describe('hardExitError feature detection', () => {
  it('calls ctx.sync.exit when the kernel has it, else unwinds (ctx.exit / NodeExitError)', async () => {
    const { hardExitError, isExitError } = await import('../../src/runtime/exit.mjs');
    const calls = [];
    // A kernel's sync.exit never returns; this stand-in does, to see the fallback after it.
    hardExitError({ sync: { exit: (c) => calls.push(['sync', c]) }, exit: (c) => calls.push(['exit', c]) }, 7);
    assert.deepEqual(calls[0], ['sync', 7]);
    const err = hardExitError({}, 9);
    assert.ok(isExitError(err));
    assert.equal(err.code, 9);
  });
});
