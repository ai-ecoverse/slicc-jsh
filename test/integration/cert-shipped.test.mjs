/**
 * cert-review's scope (scripts/cert-review/shipped.mjs), run as a CLI on a
 * scratch git repository: which pull requests get the full review. A
 * package.json change counts as behaviour unless only devDependencies,
 * version or gitHead differ; scripts ship (install hooks run on the
 * consumer's npm install, and prepack/publish hooks change what is packed),
 * so a scripts-only change is behaviour even with an identical dist. A
 * devDependencies-only change whose build is identical records "not
 * behaviour: …", and the merge-group check (group.mjs) reports it so, never
 * as certified.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commitAll, initFixtureRepo } from '@ai-ecoverse/slicc-shared-web/testing';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const tool = join(root, 'scripts/cert-review/shipped.mjs');
const repo = mkdtempSync(join(tmpdir(), 'slicc-jsh-shipped-'));
after(() => rmSync(repo, { recursive: true, force: true }));
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const base = { name: '@ai-ecoverse/slicc-jsh', version: '0.0.0', scripts: { build: 'node scripts/build.mjs' }, devDependencies: { esbuild: '0.28.2' } };
const write = (path, text) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};
initFixtureRepo(repo, { hooks: false });
write('package.json', `${JSON.stringify(base, null, 2)}\n`);
write('docs/guide.md', 'guide\n');
write('README.md', 'readme\n');
commitAll(repo, 'base');
const baseSha = git('rev-parse', 'HEAD');

function change(name, edit) {
  git('checkout', '-q', '-B', name, baseSha);
  edit();
  commitAll(repo, name);
  const head = git('rev-parse', 'HEAD');
  const work = join(repo, '..', `${name}-work-${process.pid}`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.GITHUB_OUTPUT;
  const r = spawnSync(process.execPath, [tool, '--base', baseSha, '--head', head, '--work', work, '--dir', repo], { encoding: 'utf8', env });
  const result = JSON.parse(readFileSync(join(work, 'shipped.json'), 'utf8'));
  rmSync(work, { recursive: true, force: true });
  return { ...result, out: `${r.stdout}${r.stderr}`, code: r.status };
}
const withPackage = (pkg) => () => write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

describe('cert-review scope: what takes the full review', () => {
  it('a scripts-only change is behaviour (the dist would build identical)', () => {
    const r = change('scripts-only', withPackage({ ...base, scripts: { ...base.scripts, prepack: 'npm run build' } }));
    assert.equal(r.code, 0, r.out);
    assert.equal(r.behaviour, true, r.why);
    assert.match(r.why, /package\.json changed beyond devDependencies, version and gitHead: scripts/);
  });

  it('an added postinstall is behaviour', () => {
    const r = change('postinstall', withPackage({ ...base, scripts: { ...base.scripts, postinstall: 'node x.js' } }));
    assert.equal(r.behaviour, true, r.why);
    assert.match(r.why, /: scripts$/);
  });

  it('bin, exports, files, engines, slicc and runtime dependencies are behaviour', () => {
    const r = change('fields', withPackage({ ...base, bin: { jsh: 'x' }, exports: './x', files: ['dist'], engines: { node: '>=22' }, slicc: { commands: {} }, dependencies: { a: '1' } }));
    assert.equal(r.behaviour, true, r.why);
    assert.match(r.why, /bin, dependencies, engines, exports, files, slicc/);
  });

  it('README ships, so it is behaviour', () => {
    const r = change('readme', () => write('README.md', 'readme, changed\n'));
    assert.equal(r.behaviour, true, r.why);
  });

  it('docs alone are not behaviour', () => {
    const r = change('docs', () => write('docs/guide.md', 'guide, changed\n'));
    assert.equal(r.behaviour, false, r.why);
    assert.match(r.why, /^not behaviour: no shipped file changed/);
  });
});

describe('cert-review scope: a devDependencies-only change is recorded as not behaviour', () => {
  const dev = mkdtempSync(join(tmpdir(), 'slicc-jsh-shipped-dev-'));
  after(() => rmSync(dev, { recursive: true, force: true }));
  const g = (...a) => execFileSync('git', a, { cwd: dev, encoding: 'utf8' }).trim();
  const put = (path, text) => {
    mkdirSync(dirname(join(dev, path)), { recursive: true });
    writeFileSync(join(dev, path), text);
  };
  const pkg = (devDependencies) => ({ name: 'scratch', version: '0.0.0', private: true, scripts: { build: "node -e \"require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/a.js','x')\"" }, devDependencies });
  const lock = (devDependencies) => {
    put('package.json', `${JSON.stringify(pkg(devDependencies), null, 2)}\n`);
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--offline'], { cwd: dev, stdio: 'ignore' });
  };
  put('vendor/dep1/package.json', '{"name":"dep1","version":"1.0.0"}\n');
  put('vendor/dep2/package.json', '{"name":"dep2","version":"1.0.0"}\n');
  put('NOTICE', 'notice\n');
  initFixtureRepo(dev, { hooks: false });
  lock({ dep1: 'file:vendor/dep1' });
  commitAll(dev, 'base');
  const devBase = g('rev-parse', 'HEAD');
  lock({ dep1: 'file:vendor/dep1', dep2: 'file:vendor/dep2' });
  commitAll(dev, 'chore(deps): add dep2');
  const devHead = g('rev-parse', 'HEAD');

  it("its why, and the job output the status is written from, start with 'not behaviour: '", () => {
    const work = join(dev, '..', `dev-work-${process.pid}`);
    const output = join(dev, '..', `dev-output-${process.pid}`);
    writeFileSync(output, '');
    const env = { ...process.env, GITHUB_OUTPUT: output };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, [tool, '--base', devBase, '--head', devHead, '--work', work, '--dir', dev], { encoding: 'utf8', env, timeout: 300_000 });
    const result = JSON.parse(readFileSync(join(work, 'shipped.json'), 'utf8'));
    const out = readFileSync(output, 'utf8');
    rmSync(work, { recursive: true, force: true });
    rmSync(output, { force: true });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.equal(result.behaviour, false, result.why);
    assert.match(result.why, /^not behaviour: only devDependencies changed \(package-lock\.json, package\.json\), and dist\/ and NOTICE build identical/);
    assert.match(out, /^behaviour=false$/m);
    assert.match(out, /^why=not behaviour: only devDependencies changed/m);
  });

  it('the merge-group check reports it as not behaviour, and a certified one as certified', () => {
    const group = join(root, 'scripts/cert-review/group.mjs');
    g('checkout', '-q', '-B', 'main', devBase);
    g('checkout', '-q', '-B', 'pr1', devHead);
    g('checkout', '-q', '-B', 'pr2', devBase);
    put('README.md', 'readme\n');
    commitAll(dev, 'docs');
    const pr2 = g('rev-parse', 'HEAD');
    g('checkout', '-q', 'main');
    g('merge', '-q', '--no-ff', 'pr1', '-m', 'Merge pull request #1 from x/pr1');
    g('merge', '-q', '--no-ff', 'pr2', '-m', 'Merge pull request #2 from x/pr2');
    const groupHead = g('rev-parse', 'HEAD');
    const statuses = join(dev, '..', `statuses-${process.pid}.json`);
    writeFileSync(statuses, JSON.stringify({
      [devHead]: { state: 'success', description: 'not behaviour: only devDependencies changed (package-lock.json, package.json), and dist/ and NOTICE build identical' },
      [pr2]: { state: 'success', description: `certified @ai-ecoverse/slicc-jsh PR #2 head ${pr2} sha256=${'0'.repeat(64)}` },
    }));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.GITHUB_STEP_SUMMARY;
    const r = spawnSync(process.execPath, [group, '--base', devBase, '--head', groupHead, '--dir', dev, '--statuses', statuses, '--dry-run'], { encoding: 'utf8', env });
    rmSync(statuses, { force: true });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const line = /^group status: (.*)$/m.exec(r.stdout)?.[1] ?? '';
    assert.match(line, /^success: /, r.stdout);
    assert.ok(line.includes('#1 not behaviour'), line);
    assert.ok(line.includes(`#2 certified at ${pr2.slice(0, 12)}`), line);
    assert.ok(!line.includes('#1 certified'), line);
  });
});
