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

  it('/dev/stdin is still process.stdin', async () => {
    const r = await jsh.run(['node', '-e', "console.log(JSON.stringify(require('fs').readFileSync('/dev/stdin', 'utf8')))"], { stdin: 'piped\n' });
    assert.equal(r.stdout, '"piped\\n"\n');
  });
});
