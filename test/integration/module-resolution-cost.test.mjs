import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

// Resolving a module cost syscalls in proportion to its path's depth: the
// realpath of every resolved file lstat()ed each component again (Node's
// loaders keep a realpath cache for the process), and every import stat()ed
// its importer to see whether it was a directory. An ES module with 600
// imports (lodash-es) stat()ed itself 600 times. m26/cases/use (about 20
// npm packages) took 17-20 s here and timed out at the m-fixtures' 20 s cap
// on the bench (ai-ecoverse/slicc-jsh#241); now it takes 3.5 s (host Node: 4 s).
//
// What the test compares is the same 300-module package, imported from 1
// directory deep and from 49 deep (the median of 3 rounds). Before the fix
// the deep one took 4.4-12x as long; now 1.9-2.9x, which is the kernel's own
// per-call path walk, not jsh's. It's a ratio, so a loaded machine slows
// both alike.
describe('module resolution cost does not grow with the path depth (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  it('300 imports 49 directories deep take under 3.5x as long as 1 deep', async () => {
    const pkg = (root, name) => `
{ const dir = '${root}/node_modules/${name}';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + '/package.json', JSON.stringify({ name: '${name}', type: 'module', exports: './index.js' }));
  let src = '';
  for (let i = 0; i < 300; i++) { fs.writeFileSync(dir + '/f' + i + '.js', 'export default ' + i + ';\\n'); src += 'import f' + i + " from './f" + i + ".js';\\n"; }
  fs.writeFileSync(dir + '/index.js', src + 'export const n = f299 + 1;\\n'); }`;
    const deep = `/os/${Array.from({ length: 48 }, (_, i) => `d${i}`).join('/')}`;
    const setup = await jsh.run([
      'node',
      '-e',
      `const fs = require('fs'); ${pkg('/os/s', 'shallow')} ${pkg(deep, 'deep')}
fs.writeFileSync('/os/s/main.mjs', "const t = performance.now(); const { n } = await import('shallow'); console.log(n, performance.now() - t);");
fs.writeFileSync('${deep}/main.mjs', "const t = performance.now(); const { n } = await import('deep'); console.log(n, performance.now() - t);");`,
    ]);
    assert.equal(setup.status, 0, setup.stderr);
    const time = async (main) => {
      const r = await jsh.run(['node', main]);
      const [n, ms] = r.stdout.trim().split(' ').map(Number);
      assert.equal(n, 300, r.stderr);
      return ms;
    };
    const ratios = [];
    for (let i = 0; i < 3; i++) {
      const shallow = await time('/os/s/main.mjs');
      const deeper = await time(`${deep}/main.mjs`);
      ratios.push(deeper / shallow);
    }
    const median = ratios.sort((a, b) => a - b)[1];
    assert.ok(median < 3.5, `deep / shallow: ${ratios.map((r) => r.toFixed(2)).join(', ')}`);
  });
});
