import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devPackageTree, withJsh } from './helpers.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const version = (name) => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

// The real eslint 10 lints a project in the kernel. After its last file read
// nothing is pending but promise jobs, which must all run before the
// program finds its loop empty, or it ends without printing its results.
describe('eslint (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    for (const [path, data] of devPackageTree('eslint')) await jsh.kernel.writeFile(path, data);
    await jsh.kernel.writeFile('/os/ep/package.json', JSON.stringify({ name: 'ep', private: true, type: 'module' }));
    await jsh.kernel.writeFile('/os/ep/eslint.config.js', 'export default [{ rules: { "no-unused-vars": "error", "prefer-const": "warn" } }];\n');
    for (const n of [1, 2, 3, 4, 5, 6]) {
      await jsh.kernel.writeFile(`/os/ep/f${n}.js`, n % 2 ? `const unused${n} = 1;\n` : `let ok${n} = ${n};\nexport { ok${n} };\n`);
    }
  });
  after(() => jsh?.close());

  it('lints a directory and prints its results: errors, warnings and the summary, with exit status 1', async () => {
    assert.match(version('eslint'), /^10\./);
    const r = await jsh.run(['node', '/node_modules/eslint/bin/eslint.js', '.'], { cwd: '/os/ep' });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stderr, '');
    for (const n of [1, 3, 5]) {
      assert.ok(r.stdout.includes(`/os/ep/f${n}.js\n  1:7  error  'unused${n}' is assigned a value but never used  no-unused-vars`), r.stdout);
    }
    for (const n of [2, 4, 6]) {
      assert.ok(r.stdout.includes(`/os/ep/f${n}.js\n  1:5  warning  'ok${n}' is never reassigned. Use 'const' instead  prefer-const`), r.stdout);
    }
    assert.match(r.stdout, /✖ 6 problems \(3 errors, 3 warnings\)\n {2}0 errors and 3 warnings potentially fixable with the `--fix` option\.\n/);
  });
});
