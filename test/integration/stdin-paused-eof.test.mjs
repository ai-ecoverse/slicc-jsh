import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJshAndSh } from './helpers.mjs';

// A paused stdin pipe still reads ahead until its buffer is full, so an EOF
// that comes after pause() still gives 'end' and 'close', and the program
// waits for it, as Node's does (ai-ecoverse/slicc-jsh#289). jsh let a
// paused stdin's read go: when the EOF came later than the data (the
// golden stdio-data-end under load), the program ended first and printed
// nothing. Here the EOF comes 300 ms after the data (a child that holds
// the pipe open), every time.
describe('a paused stdin pipe still reads to its end (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJshAndSh();
    await jsh.kernel.writeFile(
      '/os/paused.js',
      [
        'const events = [];',
        'const s = process.stdin;',
        "s.on('data', (c) => { events.push(`data ${c}`); s.pause(); events.push(`paused ${s.isPaused()}`); });",
        "s.on('end', () => events.push('end'));",
        "s.on('close', () => { events.push('close'); console.log(events.join(',')); });",
      ].join('\n')
    );
  });
  after(() => jsh?.close());

  it("an EOF 300 ms after the data: 'end' and 'close' come, as in Node", async () => {
    const r = await jsh.run(['bash', '-c', '{ printf 0123456789; node -e "setTimeout(() => {}, 300)"; } | node paused.js; echo "rc=$?"'], { cwd: '/os' });
    assert.equal(r.stdout, 'data 0123456789,paused true,end,close\nrc=0\n', r.stderr);
  });

  it('the data from stdin given to the run, as the golden has it', async () => {
    const r = await jsh.run(['node', 'paused.js'], { cwd: '/os', stdin: '0123456789' });
    assert.equal(r.stdout, 'data 0123456789,paused true,end,close\n', r.stderr);
  });
});
