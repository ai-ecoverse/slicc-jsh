import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runNode } from './run-script.mjs';

const preload = () => {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-env-'));
  const file = join(dir, 'preload.cjs');
  writeFileSync(file, "if (process.argv[1] && !process.argv[1].includes('golden.mjs')) process.stderr.write('preloaded\\n');\n");
  return { dir, options: `--require ${file}` };
};

test("the host baselines don't take the runner's NODE_OPTIONS, which the pipeline's shards set to a preload (#929)", { timeout: 600_000 }, async (t) => {
  const { dir, options } = preload();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const golden = await runNode(t, ['scripts/golden.mjs', 'check', 'process-members-node22'], { NODE_OPTIONS: options });
  assert.equal(golden.status, 0, golden.out);
  assert.match(golden.out, /^ok process-members-node22$/m, golden.out);
  const jsh = await runNode(t, ['scripts/jsh-golden.mjs', 'check', 'exit-explicit'], { NODE_OPTIONS: options });
  assert.equal(jsh.status, 0, jsh.out);
  assert.match(jsh.out, /^ok exit-explicit$/m, jsh.out);
});
