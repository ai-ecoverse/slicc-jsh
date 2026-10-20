/**
 * A failed semantic-release never ends the release's tag job green (0.29.6
 * and 0.29.7 went unnoticed that way): scripts/release-outcome.mjs, run in a
 * scratch git repository with and without a v-tag at HEAD, and its wiring in
 * .github/workflows/release.yml.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(root, 'scripts/release-outcome.mjs');
const repo = mkdtempSync(join(tmpdir(), 'slicc-jsh-release-outcome-'));
after(() => rmSync(repo, { recursive: true, force: true }));
const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
git('init', '-q');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one');

const outcome = (value) => {
  const env = { ...process.env, SEMANTIC_RELEASE: value };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [script], { cwd: repo, encoding: 'utf8', env });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

describe('release tag job: semantic-release failures are never green', () => {
  it('nothing to release is green', () => {
    const r = outcome('success');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /nothing to release/);
  });

  it('a failure before tagging fails the job', () => {
    const r = outcome('failure');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /before tagging: nothing was released/);
  });

  it('a failure after tagging fails the job too, and says the tag still publishes', () => {
    git('tag', 'v9.8.7');
    const r = outcome('failure');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /after tagging v9\.8\.7: the publish job still publishes it/);
  });

  it('a tag and a successful semantic-release are green', () => {
    const r = outcome('success');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /semantic-release tagged v9\.8\.7/);
  });

  it('release.yml wires it: the check reads the step outcome, publish still runs after a failed tag job, failures open an issue', () => {
    const y = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
    assert.match(y, /id: semantic-release\n\s+name: [^\n]*\n\s+run: npx semantic-release\n\s+continue-on-error: true/);
    assert.match(y, /SEMANTIC_RELEASE: \$\{\{ steps\.semantic-release\.outcome \}\}\n\s+run: \|\n\s+set -euo pipefail\n\s+node scripts\/release-outcome\.mjs 2>&1 \| tee "\$RUNNER_TEMP\/outcome\.out"\n/);
    assert.match(y, /publish:[\s\S]*?if: always\(\) && github\.ref == 'refs\/heads\/main' && needs\.tag\.outputs\.tags != ''/);
    assert.match(y, /refuse to publish: HEAD is \$head, tag v\$version is \$tagged/);
    assert.match(y, /alert:\n[\s\S]*needs: \[tag, publish\]\n[\s\S]*\(needs\.tag\.result == 'failure' \|\| needs\.publish\.result == 'failure'\)\n[\s\S]*gh issue create --title "release of/);
  });
});
