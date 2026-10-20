import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { kernelFits, kernelPackage } from '../../scripts/cert-review/lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages;
const kernels = [
  ...Object.entries(pkg.devDependencies)
    .filter(([alias]) => alias.startsWith('kernel-cert-'))
    .map(([alias, spec]) => [alias, /@(\d+\.\d+\.\d+)$/.exec(spec)[1]]),
  ['dev', lock['node_modules/@ai-ecoverse/slicc-kernel'].version],
];
const engines = (key) => lock[key]?.engines?.['slicc-kernel'];

describe('each cert kernel gets the @ai-ecoverse packages whose engines.slicc-kernel it meets', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'cert-compat-'));
  after(() => rmSync(scratch, { recursive: true, force: true }));

  it('kernelFits reads >=x.y.z and nothing else', () => {
    assert.equal(kernelFits('>=1.130.2', '1.130.2'), true);
    assert.equal(kernelFits('>=1.130.2', '1.134.3'), true);
    assert.equal(kernelFits('>=1.130.2', '1.120.2'), false);
    assert.equal(kernelFits('>= 1.48.3', '1.72.0'), true);
    assert.throws(() => kernelFits('^1.130.0', '1.134.3'), /engines\.slicc-kernel \^1\.130\.0 is not >=x\.y\.z/);
  });

  for (const [name, version] of kernels) {
    it(`${name} (${version}): every @ai-ecoverse devDependency in the lockfile fits it, or its cert-compat- alias does`, () => {
      for (const key of Object.keys(lock).filter((k) => /^node_modules\/@ai-ecoverse\/[^/]+$/.test(k) && !k.endsWith('/slicc-kernel'))) {
        const sub = key.split('/').pop();
        const range = engines(key);
        if (!range || kernelFits(range, version)) continue;
        const compat = `node_modules/cert-compat-${sub}`;
        assert.ok(lock[compat], `${name} ${version}: @ai-ecoverse/${sub} needs ${range} and there is no cert-compat-${sub}`);
        assert.ok(!engines(compat) || kernelFits(engines(compat), version), `${name} ${version}: cert-compat-${sub} needs ${engines(compat)}`);
      }
    });
  }

  const base = (own, compat) => {
    const dir = mkdtempSync(join(scratch, 'nm-'));
    mkdirSync(join(dir, '@ai-ecoverse/wasm-bash'), { recursive: true });
    writeFileSync(join(dir, '@ai-ecoverse/wasm-bash/package.json'), JSON.stringify({ name: '@ai-ecoverse/wasm-bash', version: '5.3.0-21', engines: { 'slicc-kernel': own } }));
    if (compat) {
      mkdirSync(join(dir, 'cert-compat-wasm-bash'));
      writeFileSync(join(dir, 'cert-compat-wasm-bash/package.json'), JSON.stringify({ name: '@ai-ecoverse/wasm-bash', version: '5.3.0-20', engines: { 'slicc-kernel': compat } }));
    }
    return dir;
  };

  it("a kernel the tree's own package fits gets it", () => {
    const dir = base('>=1.130.2', '>=1.48.3');
    assert.deepEqual(kernelPackage(dir, 'wasm-bash', '1.134.3'), { dir: join(dir, '@ai-ecoverse/wasm-bash'), version: '5.3.0-21' });
  });

  it('an older kernel gets the cert-compat- alias', () => {
    const dir = base('>=1.130.2', '>=1.48.3');
    assert.deepEqual(kernelPackage(dir, 'wasm-bash', '1.120.2'), { dir: join(dir, 'cert-compat-wasm-bash'), version: '5.3.0-20', compat: true });
  });

  it('stage fails, naming both, when neither fits: never a tree whose sh refuses to start', () => {
    assert.throws(() => kernelPackage(base('>=1.130.2', '>=1.100.0'), 'wasm-bash', '1.86.0'), /^Error: kernel 1\.86\.0: @ai-ecoverse\/wasm-bash@5\.3\.0-21 needs slicc-kernel >=1\.130\.2, and no cert-compat-wasm-bash devDependency fits it \(@ai-ecoverse\/wasm-bash@5\.3\.0-20 needs >=1\.100\.0\)$/);
    assert.throws(() => kernelPackage(base('>=1.130.2'), 'wasm-bash', '1.120.2'), /no cert-compat-wasm-bash devDependency fits it$/);
  });
});
