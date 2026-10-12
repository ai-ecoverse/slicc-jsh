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

  it('runs the entry from its real path (a self-require is cached), unless --preserve-symlinks-main', async () => {
    const main = [
      "console.log(__filename, process.argv[1]);",
      "if (!global.__again) { global.__again = 1; require('./main.js'); console.log('cached', require.cache[__filename] !== undefined); }",
      '',
    ].join('\n');
    await jsh.kernel.writeFile('/os/sl/package.json', '{ "type": "commonjs" }');
    await jsh.kernel.writeFile('/os/sl/real/main.js', main);
    await jsh.kernel.writeFile('/os/sl/real/main.jsh', 'console.log(__filename, process.argv[1], __dirname);\n');
    await jsh.run(['node', '-e', "require('fs').symlinkSync('real', '/os/sl/alias')"]);
    let r = await jsh.run(['node', 'alias/main.js'], { cwd: '/os/sl' });
    assert.equal(r.stdout, '/os/sl/real/main.js /os/sl/alias/main.js\ncached true\n', r.stderr);
    r = await jsh.run(['node', '--preserve-symlinks-main', 'alias/main.js'], { cwd: '/os/sl' });
    assert.equal(
      r.stdout,
      '/os/sl/alias/main.js /os/sl/alias/main.js\n/os/sl/real/main.js /os/sl/alias/main.js\ncached true\n',
      r.stderr
    );
    r = await jsh.run(['jsh', 'alias/main.jsh'], { cwd: '/os/sl' });
    assert.equal(r.stdout, '/os/sl/real/main.jsh /os/sl/alias/main.jsh /os/sl/real\n', r.stderr);
  });

  it('Module._nodeModulePaths resolves a relative directory against the cwd', async () => {
    const r = await jsh.run(['node', '-e', "console.log(JSON.stringify(require('module')._nodeModulePaths('foo')))"], {
      cwd: '/os/sl',
    });
    assert.equal(r.stdout, '["/os/sl/foo/node_modules","/os/sl/node_modules","/os/node_modules","/node_modules"]\n');
  });
});
