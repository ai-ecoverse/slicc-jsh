import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { shadowModules } from '../../scripts/cert-review/lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const nm = join(root, 'node_modules');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages;
const legs = new Map();
for (const [alias, spec] of Object.entries(pkg.devDependencies).filter(([a]) => a.startsWith('kernel-cert-'))) {
  const version = /@(\d+\.\d+\.\d+)$/.exec(spec)[1];
  if (!legs.has(version)) legs.set(version, { id: alias.slice('kernel-cert-'.length), dir: join(nm, alias), version });
}
const devVersion = lock['node_modules/@ai-ecoverse/slicc-kernel'].version;
if (!legs.has(devVersion)) legs.set(devVersion, { id: 'dev', dir: join(nm, '@ai-ecoverse/slicc-kernel'), version: devVersion });
const newest = [...legs.values()].find((l) => l.id === 'new');
const EXEC_TIMEOUT = 'exec timeout true SIGTERM null';

const scratch = mkdtempSync(join(tmpdir(), 'cert-mfx-sh-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const jsh = join(scratch, 'jsh');
mkdirSync(jsh);
cpSync(join(root, 'package.json'), join(jsh, 'package.json'));
cpSync(join(root, 'dist'), join(jsh, 'dist'), { recursive: true });

function baseNeeding(range) {
  const dest = mkdtempSync(join(scratch, 'base-'));
  mkdirSync(join(dest, '@ai-ecoverse'));
  for (const n of readdirSync(nm)) if (n !== '@ai-ecoverse') symlinkSync(join(nm, n), join(dest, n));
  for (const n of readdirSync(join(nm, '@ai-ecoverse'))) if (n !== 'wasm-bash') symlinkSync(join(nm, '@ai-ecoverse', n), join(dest, '@ai-ecoverse', n));
  const own = join(nm, '@ai-ecoverse/wasm-bash');
  const bash = join(dest, '@ai-ecoverse/wasm-bash');
  mkdirSync(bash);
  for (const f of readdirSync(own)) if (f !== 'package.json') symlinkSync(join(own, f), join(bash, f));
  const p = JSON.parse(readFileSync(join(own, 'package.json'), 'utf8'));
  writeFileSync(join(bash, 'package.json'), JSON.stringify({ ...p, engines: { ...p.engines, 'slicc-kernel': range } }));
  return dest;
}

function mfixtures(leg, base, modules = null, name = 'signal.js') {
  const work = mkdtempSync(join(scratch, `work-${leg.id}-`));
  const staged = modules ?? shadowModules(base, leg.dir, leg.version, join(work, 'nm', leg.id, 'node_modules'));
  const fx = join(work, 'mfx', leg.id, 'fx');
  mkdirSync(fx, { recursive: true });
  cpSync(join(root, 'test/fixtures/cert-review/fx/cp'), join(fx, 'cp'), { recursive: true });
  writeFileSync(join(fx, 'cp', 'long.js'), "console.log('x'.repeat(5000) + ' tail ' + (process.versions.openssl ? 'node' : 'jsh'));\n");
  writeFileSync(join(fx, '.staged'), '');
  const kernel = { id: leg.id, names: [leg.id], version: leg.version, plain: leg.dir, modules: staged };
  writeFileSync(join(work, 'stage.json'), JSON.stringify({ kernels: [kernel], published: { dir: jsh }, previous: { dir: jsh }, trees: { base } }));
  const r = spawnSync(process.execPath, [join(root, 'scripts/cert-review/mfixtures.mjs'), '--work', work, '--kernel', leg.id, '--pkg', 'new', '--case', `cp/${name}`], {
    encoding: 'utf8',
    env: { ...process.env, NODE22: process.execPath },
    timeout: 100_000,
  });
  const reruns = join(work, 'fixtures', leg.id, 'reruns');
  let res = null;
  try {
    const [file] = readdirSync(reruns);
    res = JSON.parse(readFileSync(join(reruns, file), 'utf8'))[`new cp/${name}`];
  } catch {}
  return { status: r.status, out: `${r.stdout}${r.stderr}`, jsh: res?.jsh ?? null, node: res?.node ?? null };
}

describe("the m-fixtures boot each kernel with the wasm-bash its stage picked, and fail a kernel whose sh won't start", () => {
  for (const leg of legs.values()) {
    it(`${leg.id} (${leg.version}): cp/signal.js's exec gets a shell, so its timeout is Node's`, () => {
      const r = mfixtures(leg, nm);
      assert.equal(r.status, 0, r.out);
      assert.ok(r.jsh?.includes(EXEC_TIMEOUT), `${r.jsh}\n${r.out}`);
    });
  }

  it("a tree whose own wasm-bash needs a newer kernel still gets a shell: the m-fixtures take the cert-compat- one stage linked, not the tree's", () => {
    const r = mfixtures(newest, baseNeeding('>=99.0.0'));
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /needs slicc-kernel >=99\.0\.0/);
    assert.ok(r.jsh?.includes(EXEC_TIMEOUT), `${r.jsh}\n${r.out}`);
  });

  it("a case's saved outputs keep their tail past 4000 characters, so a difference there still shows", () => {
    const r = mfixtures(newest, nm, null, 'long.js');
    assert.equal(r.status, 0, r.out);
    assert.match(r.jsh ?? '', /x{5000} tail jsh\n+\[rc=0\]$/, r.out.slice(-300));
    assert.match(r.node ?? '', /x{5000} tail node\n+\[rc=0\]$/, r.out.slice(-300));
  });

  it("a kernel that refuses its wasm-bash fails the run, naming both, before any case reports a verdict", () => {
    const base = baseNeeding('>=99.0.0');
    const modules = join(mkdtempSync(join(scratch, 'refused-')), 'node_modules');
    mkdirSync(join(modules, '@ai-ecoverse'), { recursive: true });
    for (const n of ['wasm-bash', 'wasm-coreutils']) symlinkSync(join(base, '@ai-ecoverse', n), join(modules, '@ai-ecoverse', n));
    const r = mfixtures(newest, base, modules);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, new RegExp(`^::error title=m-fixtures: no sh on kernel new::sh -c 'echo ok' on slicc-kernel ${newest.version.replaceAll('.', '\\.')} with @ai-ecoverse/wasm-bash@\\S+ gave rc=126, stderr ".*needs slicc-kernel >=99\\.0\\.0.*": every sh case and row would cover nothing$`, 'm'));
    assert.equal(r.jsh, null);
    assert.doesNotMatch(r.out, /mfixtures: wrote/);
  });
});
