/**
 * Where cert-review takes its tools from (.github/workflows/cert-review.yml):
 * main's code decides, never the code under review. A pull request's jobs
 * check out the pull request's base (a commit on main), and the merge-group
 * check checks out main itself (merge_group.base_ref): its base_sha can be
 * the speculative merge commit of the group ahead in the queue, so it is
 * only the start of the group's commit range.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const yml = readFileSync(join(root, '.github/workflows/cert-review.yml'), 'utf8');
const job = (name) => {
  const start = yml.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `no job ${name}`);
  const rest = yml.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[\w-]+:\n/);
  return end < 0 ? rest : rest.slice(0, end + 1);
};

describe('cert-review checks its tools out from main', () => {
  it("the merge-group check checks out main (base_ref), and uses base_sha only for the group's commit range", () => {
    const g = job('merge-group');
    assert.match(g, /ref: \$\{\{ github\.event\.merge_group\.base_ref \}\}/);
    assert.doesNotMatch(g, /ref: \$\{\{ github\.event\.merge_group\.base_sha \}\}/);
    assert.match(g, /BASE: \$\{\{ github\.event\.merge_group\.base_sha \}\}[\s\S]*group\.mjs --base "\$BASE"/);
  });

  it("no job checks out a merge group's base_sha or head", () => {
    for (const m of yml.matchAll(/ref: \$\{\{ ([^}]+) \}\}/g)) {
      assert.ok(!/merge_group\.(base_sha|head_sha|head_ref)/.test(m[1]), `a checkout of ${m[1]}`);
    }
  });

  it("every pull request job checks out the pull request's base, never its head or merge commit", () => {
    for (const name of ['scope', 'plan', 'bench', 'review', 'record']) {
      const refs = [...job(name).matchAll(/ref: \$\{\{ ([^}]+) \}\}/g)].map((m) => m[1]);
      assert.deepEqual(refs, ['github.event.pull_request.base.sha'], `${name} checks out ${refs.join(', ')}`);
    }
  });
});
