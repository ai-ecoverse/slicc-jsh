/**
 * fs.watchFile inside a kernel program, with the changes made from outside
 * it (the test, through the kernel), which the goldens can't do: the program
 * marks each event in a file, and the test makes the next change once it is
 * there.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

const decoder = new TextDecoder();

describe('fs.watchFile in the kernel', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  /** The text of a kernel file, or null while it isn't there. */
  const read = async (path) => {
    try {
      return decoder.decode(await jsh.kernel.readFile(path));
    } catch {
      return null;
    }
  };
  /** Run a program; `.ended` is its result once it has exited. */
  const start = (argv) => {
    const run = jsh.run(argv, { cwd: '/tmp' });
    run.then((r) => (run.ended = r));
    return run;
  };
  /** Wait until `path` (the program's event log) has `count` lines; fail if the program ends first. */
  const lines = async (run, path, count) => {
    for (;;) {
      const text = await read(path);
      if (text !== null && text.split('\n').filter(Boolean).length >= count) return text;
      if (run.ended) assert.fail(`the program ended (${run.ended.status}): ${run.ended.stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it('sees another process create, grow and remove the file, then exits once unwatched', async () => {
    await jsh.kernel.writeFile(
      '/tmp/watch.js',
      [
        "const fs = require('fs');",
        "const log = (s) => fs.appendFileSync('/tmp/watch.log', s + '\\n');",
        'let n = 0;',
        "fs.watchFile('/tmp/watched.txt', { interval: 10 }, (curr, prev) => {",
        '  log(`${n} ${prev.size}->${curr.size} ${curr.isFile()} ${curr.nlink}`);',
        "  if (++n === 4) fs.unwatchFile('/tmp/watched.txt');",
        '});',
      ].join('\n')
    );
    const run = start(['node', '/tmp/watch.js']);
    await lines(run, '/tmp/watch.log', 1);
    await jsh.kernel.writeFile('/tmp/watched.txt', 'abc');
    await lines(run, '/tmp/watch.log', 2);
    await jsh.kernel.writeFile('/tmp/watched.txt', 'abcdefg');
    await lines(run, '/tmp/watch.log', 3);
    // Another program removes it.
    const rm = await jsh.run(['node', '-e', "require('fs').unlinkSync('/tmp/watched.txt')"]);
    assert.equal(rm.status, 0, rm.stderr);
    const r = await run;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(await read('/tmp/watch.log'), '0 0->0 false 0\n1 0->3 true 1\n2 3->7 true 1\n3 7->0 false 0\n');
  });

  it('keeps polling after a listener throws into an uncaughtException handler, in a .jsh script', async () => {
    await jsh.kernel.writeFile(
      '/tmp/throws.jsh',
      [
        "const fs = require('fs');",
        "const log = (s) => fs.appendFileSync('/tmp/throws.log', s + '\\n');",
        "process.on('uncaughtException', (e) => log('caught ' + e.message));",
        "fs.writeFileSync('/tmp/throws.txt', 'a');",
        "fs.watchFile('/tmp/throws.txt', { interval: 10 }, (curr) => {",
        '  log(`change ${curr.size}`);',
        "  if (curr.size >= 100) fs.unwatchFile('/tmp/throws.txt');",
        '  else throw new Error(`from listener at ${curr.size}`);',
        '});',
        "log('watching');",
      ].join('\n')
    );
    const run = start(['jsh', '/tmp/throws.jsh']);
    await lines(run, '/tmp/throws.log', 1);
    // A poll may not have seen 'a' yet: grow it until a listener has thrown.
    let size = 1;
    while (!(await read('/tmp/throws.log')).includes('caught')) {
      if (run.ended) assert.fail(`the program ended (${run.ended.status}): ${run.ended.stderr}`);
      await jsh.kernel.writeFile('/tmp/throws.txt', 'a'.repeat(++size));
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await jsh.kernel.writeFile('/tmp/throws.txt', 'b'.repeat(100));
    const r = await run;
    assert.equal(r.status, 0, r.stderr);
    const log = (await read('/tmp/throws.log')).split('\n').filter(Boolean);
    assert.equal(log.shift(), 'watching');
    assert.equal(log.pop(), 'change 100');
    assert.ok(log.length >= 2 && log.length % 2 === 0, log.join('|'));
    for (let i = 0; i < log.length; i += 2) {
      const at = log[i].match(/^change (\d+)$/)?.[1];
      assert.ok(at && Number(at) < 100, log[i]);
      assert.equal(log[i + 1], `caught from listener at ${at}`);
    }
  });
});
