import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

// detached: true is setsid() on slicc-kernel 1.74.0+ (ctx.spawn / sync.run
// `session: true`), as Node's is on POSIX. The child-process-detached golden
// pins the groups against Node 22.22.0; this covers the terminal.
describe('child_process detached (kernel terminal)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  const decoder = new TextDecoder();
  async function onTerminal(script, steps = []) {
    await jsh.kernel.writeFile('/os/detached-case.js', script);
    let out = '';
    const term = await jsh.kernel.openTerminal(['node', 'detached-case.js'], {
      cwd: '/os',
      cols: 100,
      rows: 30,
      onData: (d) => {
        out += decoder.decode(d);
      },
    });
    const until = async (re) => {
      for (let i = 0; i < 400 && !re.test(out); i++) await new Promise((r) => setTimeout(r, 25));
    };
    for (const step of steps) {
      await until(step.after);
      step.do(term);
    }
    const status = await Promise.race([term.exited, new Promise((r) => setTimeout(() => r('timeout'), 30000))]);
    if (status === 'timeout') term.close();
    return { out: out.replace(/\r\n/g, '\n').replace(/\x1b\[[0-9;]*m/g, ''), status };
  }

  const exists = async (path) =>
    (await jsh.run(['node', '-e', `console.log(require('fs').existsSync(${JSON.stringify(path)}))`], { cwd: '/os' })).stdout.trim();

  it('^C ends the program and its attached child, not a detached one; a detached child has no controlling terminal', async () => {
    const child = (mark) =>
      `const fs = require('fs'); let tty; try { fs.openSync('/dev/tty', 'r'); tty = 'open'; } catch (e) { tty = e.code; } fs.writeFileSync('${mark}.tty', tty); setTimeout(() => fs.writeFileSync('${mark}', 'alive'), 1500);`;
    const { out, status } = await onTerminal(
      [
        "const cp = require('child_process');",
        `cp.spawn(process.execPath, ['-e', ${JSON.stringify(child('/tmp/det-on'))}], { stdio: 'ignore', detached: true }).unref();`,
        `cp.spawn(process.execPath, ['-e', ${JSON.stringify(child('/tmp/det-off'))}], { stdio: 'ignore' });`,
        "setTimeout(() => console.log('ready'), 600);",
        'setTimeout(() => {}, 20000);',
        '',
      ].join('\n'),
      [{ after: /ready/, do: (t) => t.write('\x03') }]
    );
    assert.equal(status, 130, out);
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(await exists('/tmp/det-on'), 'true', 'the detached child outlives ^C');
    assert.equal(await exists('/tmp/det-off'), 'false', 'the attached child dies with ^C');
    const ttys = await jsh.run(
      ['node', '-e', "const fs = require('fs'); console.log(fs.readFileSync('/tmp/det-on.tty', 'utf8'), fs.readFileSync('/tmp/det-off.tty', 'utf8'))"],
      { cwd: '/os' }
    );
    assert.equal(ttys.stdout.trim(), 'ENXIO open');
  });
});
