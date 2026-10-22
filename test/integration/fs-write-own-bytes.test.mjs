import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { kernelAtLeast, kernelVersion, withJsh } from './helpers.mjs';

const skip = !kernelAtLeast('1.146.2') && `slicc-kernel ${kernelVersion} sends a sync write's whole backing buffer per chunk (ai-ecoverse/slicc-kernel#1429)`;

describe('fs.writeSync of a view into a large buffer (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  it('writes its own bytes, not the view\'s 2 GB buffer for each chunk', { skip }, async () => {
    await jsh.kernel.writeFile(
      '/os/view.js',
      [
        "const fs = require('fs');",
        'const big = Buffer.from(new ArrayBuffer(2147023008));',
        'const at = 1024 * 1024 * 1024; const n = 4 * 1024 * 1024 + 3;',
        'for (let i = 0; i < n; i++) big[at + i] = (i * 31) & 0xff;',
        "const fd = fs.openSync('view.bin', 'w');",
        'let done = 0;',
        'while (done < n) done += fs.writeSync(fd, big, at + done, Math.min(1 << 20, n - done));',
        'fs.closeSync(fd);',
        "fs.writeFileSync('whole.bin', big.subarray(at, at + n));",
        'const want = big.subarray(at, at + n);',
        "console.log(done, fs.readFileSync('view.bin').equals(want), fs.readFileSync('whole.bin').equals(want));",
      ].join('\n')
    );
    const before = process.resourceUsage().maxRSS;
    const r = await jsh.run(['node', 'view.js']);
    const grew = (process.resourceUsage().maxRSS - before) * 1024;
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, `${4 * 1024 * 1024 + 3} true true\n`);
    assert.ok(grew < 1024 ** 3, `the peak RSS grew by ${grew} bytes`);
  });
});
