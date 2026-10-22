import assert from 'node:assert/strict';
import { test } from 'node:test';
import { caseDirs, runNode } from './run-script.mjs';

export const PARTS = 4;

export function goldenPart(part) {
  const names = caseDirs('test/golden/fixtures').filter((_, i) => i % PARTS === part);
  test(`goldens ${part + 1} of ${PARTS}: ${names.length} fixtures on host Node 22.22.0 and in the kernel, byte for byte`, { timeout: 900_000 }, async (t) => {
    assert.ok(names.length > 0);
    const { status, out } = await runNode(t, ['scripts/golden.mjs', 'check', ...names], { GOLDEN_JOBS: process.env.GOLDEN_JOBS ?? '2' });
    assert.equal(status, 0, out);
    assert.match(out, new RegExp(`^golden check: ${names.length} fixture\\(s\\)$`, 'm'), out);
    const ok = new Set(out.match(/^ok \S+$/gm)?.map((line) => line.slice(3)));
    assert.deepEqual(names.filter((name) => !ok.has(name)), [], out);
    if (process.platform === 'linux') assert.doesNotMatch(out, /: host skipped /, out);
  });
}
