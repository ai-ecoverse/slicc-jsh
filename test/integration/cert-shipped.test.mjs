/**
 * cert-review's scope (scripts/cert-review/shipped.mjs), run as a CLI on a
 * scratch git repository: which pull requests get the full review. A
 * package.json change counts as behaviour unless only devDependencies,
 * version or gitHead differ; scripts ship (install hooks run on the
 * consumer's npm install, and prepack/publish hooks change what is packed),
 * so a scripts-only change is behaviour even with an identical dist.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const tool = join(root, 'scripts/cert-review/shipped.mjs');
const repo = mkdtempSync(join(tmpdir(), 'slicc-jsh-shipped-'));
after(() => rmSync(repo, { recursive: true, force: true }));
const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' }).trim();
const base = { name: '@ai-ecoverse/slicc-jsh', version: '0.0.0', scripts: { build: 'node scripts/build.mjs' }, devDependencies: { esbuild: '0.28.2' } };
const write = (path, text) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};
git('init', '-q');
write('package.json', `${JSON.stringify(base, null, 2)}\n`);
write('docs/guide.md', 'guide\n');
write('README.md', 'readme\n');
git('add', '-A');
git('commit', '-q', '-m', 'base');
const baseSha = git('rev-parse', 'HEAD');

function change(name, edit) {
  git('checkout', '-q', '-B', name, baseSha);
  edit();
  git('add', '-A');
  git('commit', '-q', '-m', name);
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
