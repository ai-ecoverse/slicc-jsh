import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  rewriteDynamicImports,
  shouldRunAsEsm,
  transformEsm,
} from '../../src/runtime/esm/transform.mjs';

describe('esm transform (acorn)', () => {
  it('detect-module: dynamic import() alone stays CJS; static import/TLA are ESM', () => {
    assert.equal(
      shouldRunAsEsm("const fs=require('fs'); import('x').then(()=>{});\n"),
      false
    );
    assert.equal(shouldRunAsEsm("import x from 'y';\nconsole.log(x);\n"), true);
    assert.equal(shouldRunAsEsm("export const a = 1;\n"), true);
    assert.equal(shouldRunAsEsm("await Promise.resolve(1);\n"), true);
    assert.equal(shouldRunAsEsm("const a = 1;\n"), false);
    // import/export-looking text inside a template must not force ESM
    assert.equal(shouldRunAsEsm('const s = `import x from "y"`;\n'), false);
  });

  it('rewrites import() for CJS eval without touching string literals', () => {
    const { code, changed, binding } = rewriteDynamicImports(
      "const fs=require('fs'); import('x').then(()=>{}); const s='import(y)';\n"
    );
    assert.equal(changed, true);
    assert.equal(binding, '__import');
    assert.match(code, /__import\('x'\)/);
    assert.match(code, /const s='import\(y\)'/);
    assert.equal(rewriteDynamicImports('const a = 1;\n').changed, false);
  });

  it('avoids colliding with an existing __import binding', () => {
    const { code, changed, binding } = rewriteDynamicImports(
      "const __import = 1; import('x').then(()=>{});\n"
    );
    assert.equal(changed, true);
    assert.equal(binding, '__import$1');
    assert.match(code, /__import\$1\('x'\)/);
    assert.match(code, /const __import = 1/);
  });

  it('handles multi-line import/export (prettier style)', () => {
    const src = `
import {
  a,
  b as c,
} from './mod.mjs';
export {
  c as d,
};
console.log(a, c);
`;
    const { code, staticSpecs } = transformEsm(src, '/os/main.mjs');
    assert.deepEqual(staticSpecs, ['./mod.mjs']);
    assert.match(code, /__importSync\("\.\/mod\.mjs"\)/);
    assert.match(code, /Object\.defineProperty\(__live, "a"/);
    assert.match(code, /Object\.defineProperty\(__live, "c"/);
    assert.match(code, /__live\["a"\]/);
    assert.match(code, /Object\.defineProperty\(__exports, "d"/);
    assert.doesNotMatch(code, /^\s*import\s/m);
  });

  it('handles export default function across lines', () => {
    const src = `
export default function greet(
  name
) {
  return 'hi ' + name;
}
`;
    const { code } = transformEsm(src, '/os/g.mjs');
    assert.match(code, /function greet/);
    assert.match(code, /Object\.defineProperty\(__exports, "default"/);
    assert.doesNotMatch(code, /export default/);
  });

  it('handles $ identifiers', () => {
    const src = `import $ from 'jquery';\nexport const $x = 1;\nconsole.log($, $x);\n`;
    const { code, staticSpecs } = transformEsm(src, '/os/main.mjs');
    assert.deepEqual(staticSpecs, ['jquery']);
    assert.match(code, /Object\.defineProperty\(__live, "\$"/);
    assert.match(code, /__live\["\$"\]/);
    assert.match(code, /Object\.defineProperty\(__exports, "\$x"/);
  });

  it('does not rewrite import( or import.meta inside strings/comments', () => {
    const src = `
import fs from 'fs';
// mention import( and import.meta here
const msg = "call import(fs) and import.meta.url";
console.log(msg, import.meta.url, typeof fs);
`;
    const { code } = transformEsm(src, '/os/main.mjs');
    assert.match(code, /"call import\(fs\) and import\.meta\.url"/);
    assert.match(code, /\/\/ mention import\( and import\.meta here/);
    assert.match(code, /__meta\.url/);
  });

  it('hoists imports before body and registers export getters first', () => {
    const src = `
console.log('body');
import { x } from './dep.mjs';
export const y = 1;
`;
    const { code } = transformEsm(src, '/os/main.mjs');
    const getterAt = code.indexOf('Object.defineProperty(__exports, "y"');
    const importAt = code.indexOf('__importSync');
    const bodyAt = code.indexOf("console.log('body')");
    assert.ok(getterAt >= 0 && importAt >= 0 && bodyAt >= 0);
    assert.ok(getterAt < importAt, 'export getters before imports');
    assert.ok(importAt < bodyAt, 'imports before body');
  });

  it('expands object shorthand of imported live bindings (lodash-es)', () => {
    const short = transformEsm(
      `import x from './one.js';\nconst o = { x };\nconsole.log(o);\n`,
      '/os/short.js'
    );
    assert.match(short.bodyCode, /const o = \{ x: __live\["x"\] \}/);
    assert.doesNotMatch(short.bodyCode, /\{\s*__live/);

    const named = transformEsm(
      `import { x as y } from './one.js';\nconsole.log({ y });\n`,
      '/os/short3.js'
    );
    assert.match(named.bodyCode, /\{\s*y: __live\["y"\]\s*\}/);

    const def = transformEsm(
      `import x from './one.js';\nexport default { x };\n`,
      '/os/shortdef.js'
    );
    assert.match(def.code, /var __default_\d+ = \(\{ x: __live\["x"\] \}\)/);

    // Param names that collide with imports must stay bindings (lodash.default.js).
    const params = transformEsm(
      `import func from './f.js';\nimport object from './o.js';\nvar mixin = (function(func) {\n  return function(object, source) { return func(object, source); };\n})(func);\nexport default mixin;\n`,
      '/os/params.js'
    );
    assert.match(params.bodyCode, /function\(func\)/);
    assert.match(params.bodyCode, /function\(object, source\)/);
    assert.doesNotMatch(params.bodyCode, /function\(__live/);
  });
});
