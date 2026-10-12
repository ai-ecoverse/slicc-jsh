import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withJsh } from './helpers.mjs';

// The golden fixtures modules-realpath / modules-preserve-symlinks pin the
// Node behaviour; the host harness cannot set NODE_PRESERVE_SYMLINKS.
describe('module resolution and symlinked packages (kernel)', () => {
  let jsh;
  const script = readFileSync(new URL('../golden/fixtures/modules-realpath/script.js', import.meta.url));
  before(async () => {
    jsh = await withJsh();
    await jsh.kernel.writeFile('/os/mr/package.json', '{ "type": "commonjs" }');
    await jsh.kernel.writeFile('/os/mr/script.js', script);
  });
  after(() => jsh?.close());

  it('NODE_PRESERVE_SYMLINKS=1 keeps the link path', async () => {
    const r = await jsh.run(['node', 'script.js'], { cwd: '/os/mr', env: { NODE_PRESERVE_SYMLINKS: '1' } });
    assert.match(r.stdout, /^require W\/node_modules\/dep\/i\.js MODULE_NOT_FOUND$/m);
  });

  it('a .jsh requiring a symlinked package gets its real path', async () => {
    await jsh.kernel.writeFile(
      '/os/mr/use.jsh',
      [
        "require('./script.js');",
        '',
      ].join('\n')
    );
    const r = await jsh.run(['jsh', 'use.jsh'], { cwd: '/os/mr' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^require W\/node_modules\/\.pnpm\/dep@1\.0\.0\/node_modules\/dep\/i\.js peer-ok$/m);
  });
});
