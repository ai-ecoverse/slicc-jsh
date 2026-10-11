import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sourceLooksLikeEsm, transformEsm } from '../../src/runtime/esm/transform.mjs';

describe('esm transform (acorn)', () => {
  it('detects import/export', () => {
    assert.equal(sourceLooksLikeEsm('import x from "y";\n'), true);
    assert.equal(sourceLooksLikeEsm('export const a = 1;\n'), true);
    assert.equal(sourceLooksLikeEsm('const a = 1;\n'), false);
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
    assert.match(code, /const a = /);
    assert.match(code, /const c = /);
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
    assert.match(code, /const \$ = /);
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
});
