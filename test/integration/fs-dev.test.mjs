import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

// /dev on slicc-kernel 1.69+ (Linux's devices; the goldens fs-dev-node22 and
// fs-dev-async-node22 compare the rest with host Node, which on macOS has no
// /dev/full).
describe('fs and /dev (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());
  const node = (code) => jsh.run(['node', '-e', code]);

  it('writing /dev/full is ENOSPC, as on Linux', async () => {
    const r = await node("try { require('fs').writeFileSync('/dev/full', 'x'); } catch (e) { console.log(e.code, e.syscall, e.message); }");
    assert.equal(r.stdout, 'ENOSPC write ENOSPC: no space left on device, write\n');
  });

  it('a device is opened once and read as a stream: many bounded reads of /dev/urandom', async () => {
    const r = await node(
      "const fs = require('fs'); const fd = fs.openSync('/dev/urandom', 'r'); const b = Buffer.alloc(4096); let n = 0; for (let i = 0; i < 64; i++) n += fs.readSync(fd, b); fs.closeSync(fd); console.log(n)"
    );
    assert.equal(r.stdout, `${64 * 4096}\n`);
  });

  // The std streams by path, on the pipes kernel.run gives a program (Node on
  // a pipe; the golden harness's host Node has sockets there on Linux).
  it('/dev/stdout, /dev/stderr and /dev/fd/1 by path, in order with process.stdout', async () => {
    const r = await node(
      [
        "const fs = require('fs');",
        "fs.appendFileSync('/dev/stdout', 'append stdout\\n');",
        "fs.appendFileSync('/dev/stderr', 'append stderr\\n');",
        "const fd = fs.openSync('/dev/fd/1', 'w'); fs.writeSync(fd, 'via /dev/fd/1\\n'); fs.closeSync(fd);",
        "console.log('order 1'); fs.writeSync(1, 'order 2\\n'); fs.appendFileSync('/dev/stdout', 'order 3\\n'); console.log('order 4');",
        "const ws = fs.createWriteStream('/dev/stdout'); ws.write('stream\\n'); ws.end(() => fs.promises.appendFile('/dev/stdout', 'promise\\n').then(() => console.log('done')));",
      ].join('\n')
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'append stdout\nvia /dev/fd/1\norder 1\norder 2\norder 3\norder 4\nstream\npromise\ndone\n');
    assert.equal(r.stderr, 'append stderr\n');
  });

  it('a device fd as a child\'s stdio: /dev/null takes its output', async () => {
    const r = await node(
      "const fs = require('fs'); const cp = require('child_process'); const w = fs.openSync('/dev/null', 'w'); const s = cp.spawnSync('node', ['-e', 'console.log(1)'], { stdio: ['ignore', w, 'pipe'] }); console.log(s.status, JSON.stringify(String(s.stderr)))"
    );
    assert.equal(r.stdout, '0 ""\n');
  });

  it('/dev/stdin is still process.stdin', async () => {
    const r = await jsh.run(['node', '-e', "console.log(JSON.stringify(require('fs').readFileSync('/dev/stdin', 'utf8')))"], { stdin: 'piped\n' });
    assert.equal(r.stdout, '"piped\\n"\n');
  });
});
