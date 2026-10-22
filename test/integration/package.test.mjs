import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { root } from './run-script.mjs';

const LEFT_OUT = new Set(['.git', 'node_modules', 'dist', 'test', 'coverage', 'artifacts', 'junit']);

describe('the package npm publishes, packed from a copy of this checkout as semantic-release packs it', { timeout: 600_000 }, () => {
  const work = mkdtempSync(join(tmpdir(), 'jsh-package-'));
  const tree = join(work, 'tree');
  let tgz;
  let listing;

  before(() => {
    cpSync(root, tree, { recursive: true, filter: (src) => !LEFT_OUT.has(relative(root, src).split('/')[0]) });
    symlinkSync(join(root, 'node_modules'), join(tree, 'node_modules'), 'dir');
    const env = { ...process.env, SLICC_JSH_STRIP_SCRIPTS: '1' };
    delete env.NODE_TEST_CONTEXT;
    execFileSync('npm', ['pack', '--pack-destination', work], { cwd: tree, env, stdio: 'pipe' });
    tgz = join(work, readdirSync(work).find((name) => /^ai-ecoverse-slicc-jsh-.*\.tgz$/.test(name)));
    listing = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).split('\n').filter(Boolean);
  });

  after(() => rmSync(work, { recursive: true, force: true }));

  it('NOTICE names every package the build bundles', async () => {
    const { packagesFromMetafiles } = await import(pathToFileURL(join(tree, 'scripts/generate-notice.mjs')).href);
    const metas = readdirSync(join(tree, 'dist'))
      .filter((name) => /^meta-.*\.json$/.test(name))
      .map((name) => JSON.parse(readFileSync(join(tree, 'dist', name), 'utf8')));
    const bundled = [...packagesFromMetafiles(metas).keys()];
    assert.ok(bundled.length > 0);
    const notice = readFileSync(join(tree, 'NOTICE'), 'utf8');
    assert.deepEqual(bundled.filter((name) => !notice.includes(name)), []);
  });

  it('holds the entries, the host jsh and NOTICE, and no tests, scripts or install.sh', () => {
    for (const file of ['package/dist/node.mjs', 'package/dist/jsh.mjs', 'package/dist/host/jsh.mjs', 'package/dist/host/main.mjs', 'package/NOTICE', 'package/LICENSE', 'package/README.md']) {
      assert.ok(listing.includes(file), file);
    }
    assert.deepEqual(listing.filter((file) => /^package\/(test|scripts)\/|^package\/install\.sh$/.test(file)), []);
  });

  it('its package.json has no prepare or prepack script', () => {
    const pkg = JSON.parse(execFileSync('tar', ['-xOzf', tgz, 'package/package.json'], { encoding: 'utf8' }));
    assert.equal(pkg.scripts?.prepare, undefined);
    assert.equal(pkg.scripts?.prepack, undefined);
    assert.deepEqual(pkg.slicc.commands, { node: { abi: 'js', module: 'dist/node.mjs' }, jsh: { abi: 'js', module: 'dist/jsh.mjs' } });
  });

  it('installs globally, and a #!/usr/bin/env jsh script runs on the host jsh', () => {
    const prefix = join(work, 'global');
    execFileSync('npm', ['install', '-g', '--no-audit', '--no-fund', '--prefix', prefix, tgz], { stdio: 'pipe' });
    const env = { ...process.env, PATH: `${join(prefix, 'bin')}:${process.env.PATH}` };
    delete env.NODE_TEST_CONTEXT;
    assert.equal(execFileSync('jsh', ['--version'], { env, encoding: 'utf8' }).trim(), '0.0.0');
    const script = join(work, 'smoke.jsh');
    writeFileSync(script, '#!/usr/bin/env jsh\nconsole.log(require("sliccy:fmt").col("ok", 4) + "|", process.argv.slice(2).join(","));\n');
    chmodSync(script, 0o755);
    assert.equal(execFileSync(script, ['a', 'b'], { env, encoding: 'utf8' }), 'ok  | a,b\n');
  });
});
