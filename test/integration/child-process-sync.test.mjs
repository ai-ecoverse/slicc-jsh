import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { withJshAndSh } from './helpers.mjs';
import { createChildProcess, SYNC_RUN_KERNEL } from '../../src/runtime/builtins/child-process.mjs';

// spawnSync / execSync / execFileSync on ctx.sync.run (slicc-kernel 1.65.0+).
// Option handling and result shapes are pinned against Node 22.22.0 by the
// child-process-spawn-sync and child-process-exec-sync goldens; these cover
// what the golden harness can't: a terminal, ^C, other processes and timers
// while the call blocks, and kernels without ctx.sync.run.

describe('child_process sync forms: kernels without ctx.sync.run', () => {
  const make = (sync) =>
    createChildProcess({
      ctx: { sync },
      process: { cwd: () => '/', env: {}, nextTick: queueMicrotask },
      Buffer,
      handles: { add() {}, delete() {} },
      getStream: () => {
        throw new Error('not reached');
      },
    });

  for (const name of ['spawnSync', 'execSync', 'execFileSync']) {
    it(`${name} throws ERR_NOT_SUPPORTED naming slicc-kernel ${SYNC_RUN_KERNEL}`, () => {
      const cp = make({ fs: {}, read() {}, write() {} });
      assert.throws(
        () => cp[name]('node', name === 'execSync' ? undefined : ['-e', '']),
        (err) => {
          assert.equal(err.code, 'ERR_NOT_SUPPORTED');
          assert.equal(
            err.message,
            `slicc-jsh: child_process.${name} needs slicc-kernel ${SYNC_RUN_KERNEL} or later (ctx.sync.run); this kernel has none`
          );
          return true;
        }
      );
    });
  }

  it('fork stays unsupported', () => {
    const cp = make({ fs: {}, run() {} });
    assert.throws(() => cp.fork('x.js'), { code: 'ERR_NOT_SUPPORTED' });
  });
});

describe('child_process sync forms (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJshAndSh();
  });
  after(() => jsh?.close());

  const decoder = new TextDecoder();
  const node = (script, opts = {}) => jsh.run(['node', '-e', script], { cwd: '/os', ...opts });

  async function onTerminal(script, { steps = [] } = {}) {
    await jsh.kernel.writeFile('/os/sync-tty-case.js', script);
    let out = '';
    const term = await jsh.kernel.openTerminal(['node', 'sync-tty-case.js'], {
      cwd: '/os',
      cols: 100,
      rows: 30,
      onData: (d) => {
        out += decoder.decode(d);
      },
    });
    // console colours a terminal's output, as Node: read it plain (stripped
    // whole, so a sequence split across chunks goes too).
    const plain = () => out.replace(/\x1b\[[0-9;]*m/g, '');
    const until = async (re) => {
      for (let i = 0; i < 400 && !re.test(plain()); i++) await new Promise((r) => setTimeout(r, 25));
    };
    for (const step of steps) {
      await until(step.after);
      step.do(term);
    }
    const status = await Promise.race([term.exited, new Promise((r) => setTimeout(() => r('timeout'), 30000))]);
    if (status === 'timeout') term.close();
    return { out: plain().replace(/\r\n/g, '\n'), status };
  }

  it("stdio: 'inherit' reaches the program's terminal", async () => {
    const { out, status } = await onTerminal(
      [
        "const cp = require('child_process');",
        "console.log('parent tty', process.stdout.isTTY === true);",
        "const r = cp.spawnSync('node', ['-e', 'console.log(\"child tty\", process.stdin.isTTY === true, process.stdout.isTTY === true, process.stderr.isTTY === true, process.stdout.columns)'], { stdio: 'inherit' });",
        "console.log('result', r.status, r.stdout, r.output.join(','));",
        "cp.execSync('printf \"sh on tty: \"; [ -t 1 ] && echo yes || echo no', { stdio: 'inherit' });",
        "console.log('done');",
        '',
      ].join('\n')
    );
    assert.equal(status, 0, out);
    assert.match(out, /^parent tty true$/m);
    assert.match(out, /^child tty true true true 100$/m);
    assert.match(out, /^result 0 null ,,$/m);
    assert.match(out, /^sh on tty: yes$/m);
    assert.ok(out.indexOf('child tty') < out.indexOf('result'), out);
  });

  it('^C during execSync: the child (same process group) dies of SIGINT, and so does the program', async () => {
    const { out, status } = await onTerminal(
      [
        "const cp = require('child_process');",
        "console.log('blocking');",
        "cp.execFileSync('node', ['-e', 'console.log(\"child up\"); setTimeout(() => {}, 20000)'], { stdio: 'inherit' });",
        "console.log('not reached');",
        '',
      ].join('\n'),
      { steps: [{ after: /child up/, do: (t) => t.write('\x03') }] }
    );
    assert.equal(status, 130, out);
    assert.doesNotMatch(out, /not reached/);
  });

  it('^C during spawnSync with a SIGINT handler: the child ends by SIGINT, the handler runs after the call returns', async () => {
    const { out, status } = await onTerminal(
      [
        "const cp = require('child_process');",
        "process.on('SIGINT', () => console.log('handler ran'));",
        // Installed a turn before the call (works on kernels before 1.69.0
        // too, where ctx.signals.on took effect asynchronously).
        'setTimeout(() => {',
        "  const r = cp.spawnSync('node', ['-e', 'console.log(\"child up\"); setTimeout(() => {}, 20000)'], { stdio: ['inherit', 'inherit', 'pipe'] });",
        "  console.log('returned', r.status, r.signal);",
        '  setTimeout(() => process.exit(0), 200);',
        '}, 300);',
        '',
      ].join('\n'),
      { steps: [{ after: /child up/, do: (t) => t.write('\x03') }] }
    );
    assert.equal(status, 0, out);
    assert.match(out, /returned null SIGINT$/m);
    assert.match(out, /^handler ran$/m);
    assert.ok(out.indexOf('returned') < out.indexOf('handler ran'), out);
  });

  // slicc-kernel 1.69.0 (ai-ecoverse/slicc-kernel#421): ctx.signals.on takes
  // effect at once, so a handler installed in the same tick as a blocking
  // call is in place, as Node's is.
  it('^C during execSync with a SIGINT handler installed the same tick: the handler catches it, as in Node', async () => {
    const { out, status } = await onTerminal(
      [
        "const cp = require('child_process');",
        "process.on('SIGINT', () => console.log('handler ran'));",
        'try {',
        "  cp.execSync('node -e \\'console.log(\"child up\"); setTimeout(() => {}, 20000)\\'', { stdio: ['inherit', 'inherit', 'pipe'] });",
        "  console.log('no throw');",
        '} catch (e) {',
        "  console.log('threw', e.status, e.signal);",
        '}',
        "console.log('still running');",
        'setTimeout(() => process.exit(0), 200);',
        '',
      ].join('\n'),
      { steps: [{ after: /child up/, do: (t) => t.write('\x03') }] }
    );
    assert.equal(status, 0, out);
    assert.match(out, /threw null SIGINT$/m);
    assert.match(out, /^still running$/m);
    assert.match(out, /^handler ran$/m);
    assert.ok(out.indexOf('still running') < out.indexOf('handler ran'), out);
  });

  it('other processes go on while the program blocks; its own timers wait', async () => {
    const r = await node(`
const cp = require('child_process');
const order = [];
// An async child, once started, keeps running while the program blocks.
// (jsh's spawn() reaches the kernel on a later turn, hence the 'spawn' wait.)
const bg = cp.spawn('node', ['-e', 'setTimeout(() => require("fs").writeFileSync("/tmp/bg-mark", "bg"), 100)'], { stdio: 'ignore' });
bg.on('spawn', () => {
  setTimeout(() => order.push('timer'), 0);
  const seen = cp.execFileSync('node', ['-e', \`
    const fs = require('fs');
    const t0 = Date.now();
    (function wait() {
      if (fs.existsSync('/tmp/bg-mark')) return console.log('saw bg');
      if (Date.now() - t0 > 15000) return console.log('no bg');
      setTimeout(wait, 20);
    })();\`], { encoding: 'utf8' });
  order.push('sync returned ' + seen.trim());
});
bg.on('close', () => setTimeout(() => console.log(JSON.stringify(order)), 10));
`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim()), ['sync returned saw bg', 'timer']);
  });

  it('a child that writes more than a pipe holds never stalls', async () => {
    const r = await node(`
const cp = require('child_process');
const out = cp.execFileSync('node', ['-e', 'process.stdout.write("x".repeat(700000)); process.stderr.write("y".repeat(300000))'], { stdio: 'pipe', maxBuffer: 2e6 });
const r = cp.spawnSync('node', ['-e', 'process.stdout.write("x".repeat(700000)); process.stderr.write("y".repeat(300000))']);
console.log(out.length, r.stdout.length, r.stderr.length, r.status);
`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '700000 700000 300000 0');
  });

  it("stdio: 'inherit' stdin reads the program's own stdin; output keeps its order", async () => {
    const r = await node(
      `
const cp = require('child_process');
process.stdout.write('one\\n');
cp.execSync('read -r a; echo "child read: $a"', { stdio: 'inherit' });
process.stdout.write('three\\n');
`,
      { stdin: 'from parent stdin\n' }
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'one\nchild read: from parent stdin\nthree\n');
  });

  it('execSync failure from a .jsh script: status, stdout, stderr on the error', async () => {
    await jsh.kernel.writeFile(
      '/os/sync-case.jsh',
      [
        "const cp = require('child_process');",
        "try { cp.execSync('echo out; echo err >&2; exit 9', { stdio: 'pipe', encoding: 'utf8' }); }",
        'catch (e) { console.log(JSON.stringify([e.status, e.signal, e.stdout, e.stderr, e.message])); }',
        '',
      ].join('\n')
    );
    const r = await jsh.run(['jsh', 'sync-case.jsh'], { cwd: '/os' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim()), [
      9,
      null,
      'out\n',
      'err\n',
      'Command failed: echo out; echo err >&2; exit 9\nerr\n',
    ]);
  });

  it('nested: a sync child that itself runs execSync', async () => {
    const r = await node(`
const cp = require('child_process');
const inner = "console.log('inner:' + require('child_process').execSync('echo deep', { encoding: 'utf8' }).trim())";
console.log(cp.execFileSync('node', ['-e', inner], { encoding: 'utf8' }).trim());
`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'inner:deep');
  });
});
