import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJshAndSh } from './helpers.mjs';

// process.kill(self | 0) and process.abort() on slicc-kernel 1.72.0's
// ctx.sync.kill (ai-ecoverse/slicc-kernel#444): the program ends inside the
// call, signalled. The goldens (process-kill-self) pin what a parent sees
// against Node 22.22.0; these cover a terminal and process groups.
describe('process.kill(self) on ctx.sync.kill (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJshAndSh();
    // A probe that prints the terminal's ECHO and ICANON bits (Linux values).
    await jsh.kernel.writeFile(
      '/node_modules/tty-probe/package.json',
      JSON.stringify({ name: 'tty-probe', slicc: { commands: { 'tty-probe': { abi: 'js', module: 'probe.mjs' } } } })
    );
    await jsh.kernel.writeFile(
      '/node_modules/tty-probe/probe.mjs',
      [
        'export default async function (ctx) {',
        '  const t = await ctx.tty.getAttr(0);',
        "  await ctx.write(1, `probe echo=${(t.c_lflag & 0o10) !== 0} icanon=${(t.c_lflag & 0o2) !== 0}\\n`);",
        '}',
        '',
      ].join('\n')
    );
  });
  after(() => jsh?.close());

  const decoder = new TextDecoder();
  async function onTerminal(argv) {
    let out = '';
    const term = await jsh.kernel.openTerminal(argv, {
      cwd: '/os',
      cols: 100,
      rows: 30,
      onData: (d) => {
        out += decoder.decode(d);
      },
    });
    const status = await Promise.race([term.exited, new Promise((r) => setTimeout(() => r('timeout'), 30000))]);
    if (status === 'timeout') term.close();
    return { out: out.replace(/\r\n/g, '\n').replace(/\x1b\[[0-9;]*m/g, ''), status };
  }

  it('a raw-mode program that kills itself leaves the terminal as it found it', async () => {
    await jsh.kernel.writeFile(
      '/os/raw-kill.js',
      [
        'process.stdin.setRawMode(true);',
        "console.log('raw', process.stdin.isRaw);",
        "try { process.kill(process.pid, 'SIGTERM'); } finally { console.log('finally'); }",
        '',
      ].join('\n')
    );
    const { out, status } = await onTerminal(['bash', '-c', 'tty-probe; node raw-kill.js; echo "status=$?"; tty-probe']);
    assert.equal(status, 0, out);
    assert.match(out, /^raw true$/m);
    assert.doesNotMatch(out, /finally/);
    assert.match(out, /^status=143$/m);
    const probes = out.match(/^probe .*$/gm);
    assert.deepEqual(probes, ['probe echo=true icanon=true', 'probe echo=true icanon=true'], out);
  });

  it('process.kill(0, sig) ends the whole group, the caller included, at once', async () => {
    const r = await jsh.run(
      [
        'node',
        '-e',
        [
          "const cp = require('child_process');",
          "const c = cp.spawn(process.execPath, ['-e', 'setTimeout(() => require(\"fs\").writeFileSync(\"/tmp/pk-alive\", \"x\"), 800)'], { stdio: 'ignore' });",
          "c.on('spawn', () => {",
          "  try { process.kill(0, 'SIGTERM'); console.log('after'); } finally { console.log('finally'); }",
          '});',
        ].join('\n'),
      ],
      { cwd: '/os' }
    );
    assert.equal(r.status, 143, r.stderr);
    assert.equal(r.stdout, '');
    // The child, in the same group, is gone too: it never writes its mark.
    await new Promise((r) => setTimeout(r, 1500));
    const probe = await jsh.run(['node', '-e', "console.log(require('fs').existsSync('/tmp/pk-alive'))"], { cwd: '/os' });
    assert.equal(probe.stdout.trim(), 'false');
  });

  it('process.kill(-pgid, sig) of its own group ends it too', async () => {
    const r = await jsh.run(
      // With job control each job leads its own group: node's pgid is its pid.
      ['bash', '-c', 'set -m; node -e "try { process.kill(-process.pid, \'SIGKILL\'); } finally { console.log(\'finally\'); }"; echo "status=$?"'],
      { cwd: '/os' }
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'status=137');
  });
});
