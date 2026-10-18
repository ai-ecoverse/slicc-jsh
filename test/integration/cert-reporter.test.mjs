import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = mkdtempSync(join(tmpdir(), 'slicc-jsh-cert-reporter-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const records = (files) => {
  const paths = Object.entries(files).map(([name, source]) => {
    writeFileSync(join(dir, name), source);
    return join(dir, name);
  });
  const out = join(dir, `${Object.keys(files).join('+')}.jsonl`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', `--test-reporter=${join(root, 'scripts/cert-review/reporter.mjs')}`, `--test-reporter-destination=${out}`, ...paths], { encoding: 'utf8', env });
  const lines = readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { code: r.status, rows: lines.map((t) => `${basename(t.file)} › ${t.name}: ${t.status}`) };
};

describe("cert-review's node:test reporter: every file gets a record, so suites.mjs never calls a skipped one a '(file)' fail", () => {
  it('a file whose one top-level describe a kernel gate skips gives that suite as skip', () => {
    const r = records({
      'gated.test.mjs': `import { describe, it } from 'node:test';
describe('tls over the kernel transport (kernel)', { skip: 'slicc-kernel before 1.116.0 has no TLS on ctx.net' }, () => {
  it('one', () => {});
  it('two', () => {});
});
`,
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.rows, ['gated.test.mjs › tls over the kernel transport (kernel): skip']);
  });

  it('a skipped describe inside another is a skip under its parent; the tests around it are as before', () => {
    const r = records({
      'nested.test.mjs': `import { describe, it } from 'node:test';
describe('outer', () => {
  describe('inner gated', { skip: 'kernel too old' }, () => {
    it('never runs', () => {});
  });
  it('runs', () => {});
  it('skipped test', { skip: true }, () => {});
  it('todo test', { todo: true }, () => {});
});
`,
    });
    assert.equal(r.code, 0);
    assert.deepEqual(r.rows, ['nested.test.mjs › outer › inner gated: skip', 'nested.test.mjs › outer › runs: pass', 'nested.test.mjs › outer › skipped test: skip', 'nested.test.mjs › outer › todo test: todo']);
  });

  it('a suite that ran gives only its tests (a pass or a fail), not a record of its own', () => {
    const r = records({
      'ran.test.mjs': `import { describe, it } from 'node:test';
describe('ran', () => {
  it('passes', () => {});
  it('fails', () => { throw new Error('no'); });
});
`,
    });
    assert.equal(r.code, 1);
    assert.deepEqual(r.rows, ['ran.test.mjs › ran › passes: pass', 'ran.test.mjs › ran › fails: fail']);
  });
});
