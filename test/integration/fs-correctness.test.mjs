import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

// The golden fixture fs-correctness covers the rest; these cases print a
// DeprecationWarning with a pid on host Node, so they are asserted here.
describe('fs never deletes more than Node (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  it('rmdirSync(file, { recursive: true }) is ENOTDIR and keeps the file', async () => {
    await jsh.kernel.writeFile('/os/keep.txt', 'keep\n');
    await jsh.kernel.writeFile(
      '/os/rmdir-file.js',
      [
        "const fs = require('fs');",
        "for (const f of [() => fs.rmdirSync('keep.txt', { recursive: true }), () => fs.promises.rmdir('keep.txt', { recursive: true })]) {",
        '  try { await f(); console.log("removed"); } catch (e) { console.log(e.code, e.syscall); }',
        '}',
        "console.log(fs.readFileSync('keep.txt', 'utf8').trim());",
      ]
        .join('\n')
        .replace(/^/, '(async () => {\n')
        .concat('\n})();\n')
    );
    const r = await jsh.run(['node', 'rmdir-file.js']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'ENOTDIR rmdir\nENOTDIR rmdir\nkeep\n');
  });
});
