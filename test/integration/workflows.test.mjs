import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ci = await read('.github/workflows/ci.yml');
const pkg = JSON.parse(await read('package.json'));
const lock = JSON.parse(await read('package-lock.json'));
const input = (name) => ci.match(new RegExp(`\\n {6}${name}: (.+)\\n`))?.[1];

test('CI is one caller of slicc-shared-web pipeline.yml, at the release of the harness the tests use', async () => {
  assert.deepEqual(await readdir(new URL('../../.github/workflows/', import.meta.url)), ['ci.yml']);
  assert.deepEqual(await readdir(new URL('../../.github/', import.meta.url)), ['workflows']);
  const version = pkg.devDependencies['@ai-ecoverse/slicc-shared-web'];
  assert.match(version, /^2\.\d+\.\d+$/);
  assert.equal(lock.packages['node_modules/@ai-ecoverse/slicc-shared-web'].version, version);
  assert.match(
    ci,
    new RegExp(
      `\\njobs:\\n {2}ci:\\n {4}uses: ai-ecoverse/slicc-shared-web/\\.github/workflows/pipeline\\.yml@v${version.replaceAll('.', '\\.')}\\n {4}secrets: inherit\\n {4}with:\\n`
    )
  );
  assert.deepEqual(ci.split('\njobs:\n')[1].match(/^ {2}[a-z-]+:$/gm), ['  ci:']);
});

test('CI grants the pipeline the permissions its jobs ask for, attestations for the release included', () => {
  assert.match(
    ci,
    /\npermissions:\n {2}contents: write\n {2}actions: read\n {2}issues: write\n {2}pull-requests: write\n {2}statuses: write\n {2}id-token: write\n {2}attestations: write\n\n/
  );
});

test('CI runs on pull requests, merge groups and pushes to main, and cancels a superseded run only on a pull request', () => {
  assert.match(ci, /\non:\n {2}pull_request:\n {2}merge_group:\n {2}push:\n {4}branches: \[main\]\n/);
  assert.match(
    ci,
    /\nconcurrency:\n {2}group: ci-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}\n/
  );
  assert.doesNotMatch(ci, /workflow_dispatch|schedule:|workflow_run/);
});

test('the pipeline picks its runners, reviews no Renovate pull request, and nothing runs after a release', () => {
  for (const name of ['runs-on', 'after-release', 'review-renovate', 'release-environment', 'release-secrets', 'deploy', 'chrome']) {
    assert.equal(input(name), undefined, name);
  }
  assert.doesNotMatch(ci, /vars\.|CERT_|cert-review/);
  assert.equal(input('shards'), '4');
  assert.equal(input('timeout-minutes'), '30');
  assert.match(input('review-prompt'), /^\|$/);
});

test('the shards split exactly the files npm test runs, on the Node the kernel asks for', () => {
  assert.equal(input('test'), undefined);
  assert.equal(input('test-glob'), 'test/integration/*.test.mjs');
  assert.ok(pkg.scripts.test.endsWith(` '${input('test-glob')}'`), pkg.scripts.test);
  assert.doesNotMatch(pkg.scripts.test, /NODE_OPTIONS/);
  const kernel = lock.packages['node_modules/@ai-ecoverse/slicc-kernel'];
  assert.equal(kernel.version, pkg.devDependencies['@ai-ecoverse/slicc-kernel']);
  assert.equal(input('node-version'), `'${kernel.engines.node.replace(/^>=/, '')}'`);
  assert.equal(pkg.scripts.pretest, 'npm run browser');
  assert.match(pkg.scripts.browser, /slicc-cdp install-browser --version "\$npm_package_config_chrome"/);
  assert.deepEqual(
    Object.keys(pkg.devDependencies).filter((name) => /kernel-cert|cert-compat|^kernel-/.test(name)),
    []
  );
});

test('semantic-release publishes to npm from the trusted ci.yml, with provenance', async () => {
  assert.deepEqual(pkg.fledgling, { provider: 'github', workflow: 'ci.yml', repo: 'ai-ecoverse/slicc-jsh', publish: true });
  assert.equal(pkg.publishConfig.provenance, true);
  assert.equal(pkg.publishConfig.access, 'public');
  assert.equal(pkg.version, '0.0.0');
  const release = JSON.parse(await read('.releaserc.json'));
  assert.deepEqual(release.branches, ['main']);
  assert.ok(release.plugins.includes('@semantic-release/npm'));
  assert.doesNotMatch(JSON.stringify(release), /npmPublish/);
  assert.match(pkg.scripts.prepack, /scripts\/strip-own-scripts\.mjs$/);
});

test('the workflow has no comments but renovate annotations', () => {
  for (const line of ci.split('\n')) {
    if (/^\s*#/.test(line)) assert.match(line, /^\s*# renovate:/);
  }
});

test("Renovate follows slicc-shared-web's preset, with no cert-review rules left", async () => {
  const config = JSON.parse(await read('renovate.json'));
  assert.deepEqual(config.extends, ['github>ai-ecoverse/slicc-shared-web']);
  assert.equal(config.packageRules, undefined);
  assert.doesNotMatch(JSON.stringify(config), /cert|22\.22\.0/);
});

test('engines.slicc-kernel is the kernel CI tests, and Renovate moves it with the devDependency', async () => {
  const kernel = pkg.devDependencies['@ai-ecoverse/slicc-kernel'];
  assert.equal(pkg.engines['slicc-kernel'], `>=${kernel}`);
  assert.equal(lock.packages[''].engines['slicc-kernel'], `>=${kernel}`);
  const config = JSON.parse(await read('renovate.json'));
  const managers = config.customManagers.filter((m) => m.depNameTemplate === '@ai-ecoverse/slicc-kernel');
  assert.equal(managers.length, 1);
  const [manager] = managers;
  assert.deepEqual([manager.customType, manager.datasourceTemplate], ['regex', 'npm']);
  assert.ok(manager.managerFilePatterns.some((p) => new RegExp(p.slice(1, -1)).test('package.json')));
  const raw = await read('package.json');
  const found = manager.matchStrings.flatMap((s) => [...raw.matchAll(new RegExp(s, 'g'))].map((m) => m.groups.currentValue));
  assert.deepEqual(found, [kernel]);
});
