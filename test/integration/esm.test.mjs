import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
      const r = await run([
        'node',
        '-e',
        "import('fs').then(async fs=>{const x=await import('./x.mjs'); console.log(typeof fs.readFileSync, x.v)})",
      ]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'function 7\n');
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

  it('prettier-style multi-line imports and export default function', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile(
        '/os/node_modules/pretty-lib/package.json',
        JSON.stringify({ name: 'pretty-lib', type: 'module', main: 'index.js' })
      );
      await kernel.writeFile(
        '/os/node_modules/pretty-lib/index.js',
        [
          'export function alpha() {',
          "  return 'A';",
          '}',
          'export function beta() {',
          "  return 'B';",
          '}',
          'export default function greet(',
          '  name,',
          ') {',
          "  return 'hi ' + name;",
          '}',
        ].join('\n')
      );
      await kernel.writeFile(
        '/os/app.mjs',
        [
          'import greet, {',
          '  alpha,',
          '  beta,',
          "} from 'pretty-lib';",
          // brace in string must not confuse the transform
          "const note = 'keep { import(x) literal';",
          'console.log(greet("z"), alpha(), beta(), note.includes("import("));',
        ].join('\n')
      );
      const r = await run(['node', 'app.mjs']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'hi z A B true\n');
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

