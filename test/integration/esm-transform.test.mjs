import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sourceLooksLikeEsm, transformEsm } from '../../src/runtime/esm/transform.mjs';

describe('esm transform', () => {
  it('detects import/export', () => {
    assert.equal(sourceLooksLikeEsm('import x from "y";\n'), true);
    assert.equal(sourceLooksLikeEsm('export const a = 1;\n'), true);
    assert.equal(sourceLooksLikeEsm('const a = 1;\n'), false);
  });

  it('rewrites default import and named export', () => {
    const { code, staticSpecs } = transformEsm(
      `import fs from 'fs';\nexport const n = typeof fs.readFileSync;\n`,
      '/os/main.mjs'
    );
    assert.deepEqual(staticSpecs, ['fs']);
    assert.match(code, /__importSync\("fs"\)\.default/);
    assert.match(code, /Object\.defineProperty\(__exports, "n"/);
  });

  it('rewrites import.meta and dynamic import', () => {
    const { code } = transformEsm(
      `console.log(import.meta.url);\nimport('./x.mjs');\n`,
      '/os/main.mjs'
    );
    assert.match(code, /__meta\.url/);
    assert.match(code, /__import\('\.\/x\.mjs'\)/);
  });
});
