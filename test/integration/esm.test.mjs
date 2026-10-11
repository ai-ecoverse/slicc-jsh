import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installNpmFixture } from './fixture-npm.mjs';
import { withJsh } from './helpers.mjs';

describe('ESM (M3)', () => {
  it('runs .mjs with import/export and import.meta.url', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile(
        '/os/mod.mjs',
        'export const answer = 42;\nexport default "def";\n'
      );
      await kernel.writeFile(
        '/os/main.mjs',
        [
          "import def, { answer } from './mod.mjs';",
          "import * as ns from './mod.mjs';",
          "console.log(def, answer, ns.answer, import.meta.url.endsWith('/os/main.mjs'));",
        ].join('\n')
      );
      const r = await run(['node', 'main.mjs']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'def 42 42 true\n');
    } finally {
      close();
    }
  });

  it('dynamic import() of builtin and file', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile('/os/x.mjs', 'export const v = 7;\n');
      // -e with only import() stays CJS (require available).
      const r = await run([
        'node',
        '-e',
        "const req=require('fs'); import('./x.mjs').then(x=>console.log(typeof req.readFileSync, x.v))",
      ]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'function 7\n');
    } finally {
      close();
    }
  });

  it('-e: require+import() stays CJS; static import and TLA run as ESM', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile('/os/m.mjs', 'export default 5;\n');
      const cjs = await run([
        'node',
        '-e',
        "const fs=require('fs'); import('./m.mjs').then(m=>console.log('cjs', typeof fs.readFileSync, m.default))",
      ]);
      assert.equal(cjs.status, 0, cjs.stderr);
      assert.equal(cjs.stdout, 'cjs function 5\n');

      const esm = await run([
        'node',
        '-e',
        "import fs from 'fs'; console.log('esm', typeof fs.readFileSync)",
      ]);
      assert.equal(esm.status, 0, esm.stderr);
      assert.equal(esm.stdout, 'esm function\n');

      const tla = await run([
        'node',
        '-e',
        "const v = await Promise.resolve(9); console.log('tla', v)",
      ]);
      assert.equal(tla.status, 0, tla.stderr);
      assert.equal(tla.stdout, 'tla 9\n');
    } finally {
      close();
    }
  });

  it('import.meta.resolve and package type:module', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile('/os/pkg/package.json', JSON.stringify({ type: 'module' }));
      await kernel.writeFile('/os/pkg/a.js', 'export const a = "A";\n');
      await kernel.writeFile(
        '/os/pkg/main.js',
        [
          "import { a } from './a.js';",
          "console.log(a, import.meta.resolve('./a.js').endsWith('/os/pkg/a.js'));",
        ].join('\n')
      );
      const r = await run(['node', 'pkg/main.js']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'A true\n');
    } finally {
      close();
    }
  });

  it('imports CJS from ESM (default + named)', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile('/os/cjs.js', "module.exports = { hello: 'world', n: 1 };\n");
      await kernel.writeFile(
        '/os/main.mjs',
        "import cjs, { hello, n } from './cjs.js';\nconsole.log(cjs.hello, hello, n);\n"
      );
      const r = await run(['node', 'main.mjs']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'world world 1\n');
    } finally {
      close();
    }
  });

  it('require() of ESM returns namespace', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile('/os/e.mjs', 'export default 9;\nexport const k = "K";\n');
      await kernel.writeFile(
        '/os/main.js',
        "const m = require('./e.mjs');\nconsole.log(m.default, m.k);\n"
      );
      const r = await run(['node', 'main.js']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '9 K\n');
    } finally {
      close();
    }
  });

  it('package.json exports import condition', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile(
        '/os/node_modules/pkg/package.json',
        JSON.stringify({
          name: 'pkg',
          exports: {
            '.': { import: './esm.mjs', require: './cjs.js', default: './cjs.js' },
          },
        })
      );
      await kernel.writeFile('/os/node_modules/pkg/esm.mjs', 'export default "via-import";\n');
      await kernel.writeFile('/os/node_modules/pkg/cjs.js', 'module.exports = "via-require";\n');
      await kernel.writeFile(
        '/os/main.mjs',
        "import v from 'pkg';\nconsole.log(v);\n"
      );
      await kernel.writeFile(
        '/os/main.cjs',
        "console.log(require('pkg'));\n"
      );
      const r1 = await run(['node', 'main.mjs']);
      assert.equal(r1.status, 0, r1.stderr);
      assert.equal(r1.stdout, 'via-import\n');
      const r2 = await run(['node', 'main.cjs']);
      assert.equal(r2.status, 0, r2.stderr);
      assert.equal(r2.stdout, 'via-require\n');
    } finally {
      close();
    }
  });

  it('loads published chalk ESM (multi-line import list)', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await installNpmFixture(kernel, 'chalk');
      // chalk's index.js is prettier-formatted with a multi-line import list
      // and #imports; browser supports-color is pinned in the fixture package.json.
      await kernel.writeFile(
        '/os/app.mjs',
        [
          "import chalk from 'chalk';",
          "console.log(typeof chalk.red, chalk.red('hi'));",
        ].join('\n')
      );
      const r = await run(['node', 'app.mjs']);
      assert.equal(r.status, 0, r.stderr);
      // level 0 → chalk.red is a no-op string return
      assert.equal(r.stdout, 'function hi\n');
    } finally {
      close();
    }
  });

  it('loads fixture of published export * / export { default as } files', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await installNpmFixture(kernel, 'esm-reexports');
      await kernel.writeFile(
        '/os/app.mjs',
        [
          "import { delay, isArray } from 'esm-reexports';",
          'console.log(typeof delay, isArray([1]), isArray(1));',
        ].join('\n')
      );
      const r = await run(['node', 'app.mjs']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'function true false\n');
    } finally {
      close();
    }
  });

  it('supports $ identifiers in import/export', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile(
        '/os/node_modules/jquery-ish/package.json',
        JSON.stringify({ name: 'jquery-ish', type: 'module', exports: './$.mjs' })
      );
      await kernel.writeFile(
        '/os/node_modules/jquery-ish/$.mjs',
        'export default function $(sel) { return sel; }\nexport const $x = 3;\n'
      );
      await kernel.writeFile(
        '/os/main.mjs',
        "import $, { $x } from 'jquery-ish';\nconsole.log($('ok'), $x);\n"
      );
      const r = await run(['node', 'main.mjs']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'ok 3\n');
    } finally {
      close();
    }
  });

  it('live bindings across an import cycle', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      // Function exports are instantiated before the body runs, so B can call A.a
      // while A is still evaluating its import of B.
      await kernel.writeFile(
        '/os/a.mjs',
        [
          "import { b } from './b.mjs';",
          "export function a() { return 'a'; }",
          'export function ab() { return a() + b(); }',
        ].join('\n')
      );
      await kernel.writeFile(
        '/os/b.mjs',
        [
          "import { a } from './a.mjs';",
          "export function b() { return 'b' + a(); }",
        ].join('\n')
      );
      await kernel.writeFile(
        '/os/main.mjs',
        "import { ab } from './a.mjs';\nconsole.log(ab());\n"
      );
      const r = await run(['node', 'main.mjs']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'aba\n');
    } finally {
      close();
    }
  });

  it('hoists imports before later body statements', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile('/os/dep.mjs', 'export const flag = "hoisted";\n');
      await kernel.writeFile(
        '/os/main.mjs',
        [
          // Side effect before the import line — import must still run first.
          'const order = [];',
          'order.push("body");',
          "import { flag } from './dep.mjs';",
          'order.push(flag);',
          'console.log(order.join(","));',
        ].join('\n')
      );
      const r = await run(['node', 'main.mjs']);
      assert.equal(r.status, 0, r.stderr);
      // Import binding is available; body still runs in source order after hoist load.
      assert.equal(r.stdout, 'body,hoisted\n');
    } finally {
      close();
    }
  });
});

