/**
 * Where cert-review takes its tools from (.github/workflows/cert-review.yml):
 * main's code decides, never the code under review. A pull request's jobs
 * check out the pull request's base (a commit on main), and the merge-group
 * check checks out main itself (merge_group.base_ref): its base_sha can be
 * the speculative merge commit of the group ahead in the queue, so it is
 * only the start of the group's commit range.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

describe("cert-review's self-guard", () => {
  const GUARD = 'ai-ecoverse/slicc-shared-web/.github/actions/cert-self-guard';
  const V1_24_2 = 'f342d7cf558c817ce517bbbbc4cc46df6eac2f97';

  it('is slicc-shared-web v1.24.2, whose globs cover dot paths (scripts/cert-review/.x), in every workflow that uses it', () => {
    const uses = ['cert-review.yml', 'ci.yml', 'release.yml'].flatMap((f) =>
      [...readFileSync(join(root, '.github/workflows', f), 'utf8').matchAll(/uses: ([^\s@]+)@(\S+)/g)].filter((m) => m[1] === GUARD).map((m) => `${f} ${m[2]}`)
    );
    assert.deepEqual(uses, [`cert-review.yml ${V1_24_2}`]);
  });

  it('guards the cert workflows, tools, release scripts and fixtures: exactly these paths', () => {
    const paths = /paths: \|\n((?: {12}\S.*\n)+)/.exec(job('guard'))[1].trim().split(/\s+/);
    assert.deepEqual(paths, [
      '.github/workflows/cert*.yml',
      '.github/workflows/ci.yml',
      '.github/workflows/release.yml',
      'scripts/cert-review/**',
      'scripts/release-body.mjs',
      'scripts/release-outcome.mjs',
      '.releaserc.json',
      'test/cert-review/**',
      'test/fixtures/cert-review/**',
      '.github/actions/cert-self-guard/**',
    ]);
  });
});

describe('the light jobs run on the light pool, forks hosted', () => {
  const light =
    "runs-on: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository && 'ubuntu-latest' || vars.CERT_LIGHT_RUNNER || vars.CERT_RUNNER || 'ubuntu-latest' }}";
  for (const name of ['guard', 'merge-group', 'verdict']) {
    it(`cert-review's ${name} job: vars.CERT_LIGHT_RUNNER, else vars.CERT_RUNNER, and ubuntu-latest for a fork's pull request`, () => {
      assert.ok(job(name).includes(`\n    ${light}\n`), job(name).split('\n').find((l) => l.includes('runs-on')));
    });
  }
  it("ci's install job: Linux on the decider's light output, macOS hosted", () => {
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    assert.match(ci, /\n {6}light: \$\{\{ steps\.pick\.outputs\.light \}\}\n/);
    assert.match(ci, /\n {10}LIGHT: \$\{\{ vars\.CERT_LIGHT_RUNNER \|\| vars\.CERT_RUNNER \|\| 'ubuntu-latest' \}\}\n/);
    assert.match(ci, /const light = runner === hosted \|\| process\.env\.FORCED \? runner : process\.env\.LIGHT;/);
    const install = ci.slice(ci.indexOf('\n  install:\n'), ci.indexOf('\n  browser:\n'));
    assert.match(install, /\n {4}needs: runner\n {4}runs-on: \$\{\{ matrix\.os == 'ubuntu-latest' && needs\.runner\.outputs\.light \|\| matrix\.os \}\}\n/);
    assert.doesNotMatch(install, /sudo/);
  });
});

describe('the release reads nothing back from the registry, and files no supply-chain alert', () => {
  const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  const jobs = (yml) => [...yml.matchAll(/^ {2}([\w-]+):\n/gm)].map((m) => m[1]);

  it('its jobs are tag, publish, notes and alert: no verify on npm', () => {
    assert.deepEqual(jobs(release.slice(release.indexOf('\njobs:\n'))), ['tag', 'publish', 'notes', 'alert']);
    assert.doesNotMatch(release, /verify on npm|published\.mjs|settle\.mjs|release-line\.mjs|registry\.npmjs\.org|attestations|npm audit|dist-tags|sleep /);
  });

  it("npm view runs once, in publish, before it: a re-run's already-published check, not a wait", () => {
    const views = release.split('\n').filter((l) => /\bnpm view\b/.test(l));
    assert.deepEqual(views.map((l) => l.trim()), ['if npm view "@ai-ecoverse/slicc-jsh@$version" version > /dev/null 2>&1; then']);
    const publish = release.slice(release.indexOf('\n  publish:\n'), release.indexOf('\n  notes:\n'));
    assert.ok(publish.indexOf('npm view') < publish.indexOf('npm publish --provenance'));
  });

  it('the notes job takes the previous version from the git tags, and alerts are for the tag and publish jobs only', () => {
    const notes = release.slice(release.indexOf('\n  notes:\n'), release.indexOf('\n  alert:\n'));
    assert.match(notes, /prev=\$\(git tag --list 'v\*'/);
    assert.match(notes, /scripts\/cert-review\/carry\.mjs --from "v\$prev" --to "v\$VERSION" --release "v\$VERSION"/);
    assert.match(release.slice(release.indexOf('\n  alert:\n')), /needs: \[tag, publish\]/);
  });

  it('no workflow or script files a supply-chain alert, and the registry checkers are gone', () => {
    for (const f of ['ci.yml', 'cert-review.yml', 'release.yml']) assert.doesNotMatch(readFileSync(join(root, '.github/workflows', f), 'utf8'), /supply-chain alert/i, f);
    for (const f of ['scripts/cert-review/published.mjs', 'scripts/cert-review/settle.mjs', 'scripts/release-line.mjs']) assert.equal(existsSync(join(root, f)), false, f);
  });
});
