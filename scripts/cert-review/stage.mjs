#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { KERNEL, NAME, SEMVER, archive, kernelPackage, npmFlags, packFrom, packTree, readJson, relFiles, root, sh, sha, sri, untar } from './lib.mjs';

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    prev: { type: 'string' },
    work: { type: 'string' },
    kernels: { type: 'string', default: 'all' },
    rebuild: { type: 'boolean', default: false },
    tarball: { type: 'string', default: '' },
    'prev-tarball': { type: 'string', default: '' },
    ref: { type: 'string', default: '' },
    'prev-ref': { type: 'string', default: '' },
  },
});
const { version, prev } = values;
const VERSION_LIKE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
if (!VERSION_LIKE.test(version ?? '') || !VERSION_LIKE.test(prev ?? '')) {
  console.error('stage: --version and --prev must be versions (x.y.z or x.y.z-label)');
  process.exit(2);
}
const ref = values.ref || `v${version}`;
const prevRef = values['prev-ref'] || `v${prev}`;
const work = resolve(values.work);
mkdirSync(work, { recursive: true });

const ENFORCE_SHIM = `import { createNodeKernel as create } from './node-kernel.js';
export * from './node-kernel.js';
export const createNodeKernel = (options = {}) => create({ users: 'enforce', ...options });
`;


function kernelPins(tagTree) {
  const pkg = readJson(join(root, 'package.json'));
  const lock = readJson(join(root, 'package-lock.json'));
  const pins = [];
  for (const [alias, spec] of Object.entries(pkg.devDependencies ?? {})) {
    if (!alias.startsWith('kernel-cert-')) continue;
    const m = /^npm:@ai-ecoverse\/slicc-kernel@(\d+\.\d+\.\d+)$/.exec(spec);
    if (!m) throw new Error(`${alias}: ${spec} is not npm:${KERNEL}@x.y.z`);
    pins.push({ name: alias.slice('kernel-cert-'.length), version: m[1], integrity: lock.packages?.[`node_modules/${alias}`]?.integrity });
  }
  const tagLock = readJson(join(tagTree, 'package-lock.json'));
  const dev = tagLock.packages?.[`node_modules/${KERNEL}`];
  pins.push({ name: 'dev', version: dev.version, integrity: dev.integrity });
  const seen = new Map();
  for (const p of pins) {
    if (!SEMVER.test(p.version)) throw new Error(`kernel ${p.name}: ${p.version} is not pinned`);
    const known = seen.get(p.version);
    if (known) known.names.push(p.name);
    else seen.set(p.version, { version: p.version, integrity: p.integrity, names: [p.name] });
  }
  const order = ['new', 'dev', '186', 'floor'];
  const rank = (k) => Math.min(...k.names.map((n) => (order.includes(n) ? order.indexOf(n) : order.length)));
  return [...seen.values()].sort((a, b) => rank(a) - rank(b)).map((k) => ({ ...k, names: [...k.names].sort((x, y) => order.indexOf(x) - order.indexOf(y)), id: [...k.names].sort((x, y) => order.indexOf(x) - order.indexOf(y))[0] }));
}

function stageKernel(pin) {
  const dir = join(work, 'kernels', pin.version);
  const tgz = packFrom(`${KERNEL}@${pin.version}`, join(work, 'kernels'));
  const integrity = sri(tgz);
  if (!pin.integrity || pin.integrity !== integrity) {
    throw new Error(`kernel ${pin.version}: the registry tarball is ${integrity}, the lockfile pins ${pin.integrity ?? 'nothing'}`);
  }
  const plain = untar(tgz, join(dir, 'plain'));
  const shimmed = join(dir, 'enforce', 'package');
  rmSync(join(dir, 'enforce'), { recursive: true, force: true });
  cpSync(plain, shimmed, { recursive: true });
  renameSync(join(shimmed, 'dist/node.js'), join(shimmed, 'dist/node-kernel.js'));
  writeFileSync(join(shimmed, 'dist/node.js'), ENFORCE_SHIM);
  return { ...pin, tgz, sha256: sha('sha256', tgz), plain, enforce: shimmed };
}

function shadowModules(base, kernelDir, kernel, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(base)) {
    if (name !== '@ai-ecoverse') {
      symlinkSync(join(base, name), join(dest, name));
      continue;
    }
    mkdirSync(join(dest, name));
    for (const sub of readdirSync(join(base, name))) {
      if (sub === 'slicc-kernel') continue;
      const pick = kernelPackage(base, sub, kernel);
      if (pick.compat) console.log(`stage: kernel ${kernel} gets ${name}/${sub}@${pick.version} (cert-compat-${sub}): the tree's own needs a newer kernel`);
      symlinkSync(pick.dir, join(dest, name, sub));
    }
    symlinkSync(kernelDir, join(dest, name, 'slicc-kernel'));
  }
  return dest;
}

function packageDiff(a, b) {
  const fa = relFiles(a);
  const fb = relFiles(b);
  const all = [...new Set([...fa, ...fb])].sort();
  return all.filter((f) => !fa.includes(f) || !fb.includes(f) || sha('sha256', join(a, f)) !== sha('sha256', join(b, f)));
}

let pubTgz;
if (values.tarball) {
  mkdirSync(join(work, 'pub'), { recursive: true });
  pubTgz = join(work, 'pub', `artifact-${version}.tgz`);
  cpSync(resolve(values.tarball), pubTgz);
} else pubTgz = packFrom(`${NAME}@${version}`, join(work, 'pub'));
const pubDir = untar(pubTgz, join(work, 'pub/x'));
let prevTgz;
if (values['prev-tarball']) {
  mkdirSync(join(work, 'prevpub'), { recursive: true });
  prevTgz = join(work, 'prevpub', `base-${prev}.tgz`);
  cpSync(resolve(values['prev-tarball']), prevTgz);
} else prevTgz = packFrom(`${NAME}@${prev}`, join(work, 'prevpub'));
const prevDir = untar(prevTgz, join(work, 'prevpub/x'));

const tag = join(work, 'tag');
const tagCommit = archive(tag, ref);
const prevCommit = sh('git', ['rev-parse', `${prevRef}^{commit}`], { cwd: root }).trim();
sh('npm', ['ci', ...npmFlags], { cwd: tag });

let rebuilt = null;
if (values.rebuild) {
  const tgz = join(work, `rebuilt-${version}.tgz`);
  renameSync(packTree(tag, version, tagCommit, join(work, 'rebuilt-tmp'), ref), tgz);
  const dir = untar(tgz, join(work, 'rebuilt/x'));
  rebuilt = {
    tarball: tgz,
    sha256: sha('sha256', tgz),
    reproducible: sha('sha256', tgz) === sha('sha256', pubTgz),
    differingFiles: packageDiff(pubDir, dir),
    dir,
  };
}
if (!values.rebuild) sh('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], { cwd: tag });
rmSync(join(tag, 'dist'), { recursive: true, force: true });
cpSync(join(pubDir, 'dist'), join(tag, 'dist'), { recursive: true });

const neg = join(work, 'neg');
rmSync(neg, { recursive: true, force: true });
const topLevel = new Set(['node_modules', 'dist', '.git'].map((d) => join(tag, d)));
cpSync(tag, neg, { recursive: true, verbatimSymlinks: true, filter: (src) => !topLevel.has(src) });
cpSync(join(prevDir, 'dist'), join(neg, 'dist'), { recursive: true });
{
  const p = readJson(join(neg, 'package.json'));
  p.version = prev;
  writeFileSync(join(neg, 'package.json'), `${JSON.stringify(p, null, 2)}\n`);
}

const base = join(work, 'base/node_modules');
rmSync(join(work, 'base'), { recursive: true, force: true });
mkdirSync(join(work, 'base'), { recursive: true });
renameSync(join(tag, 'node_modules'), base);

const wanted = values.kernels === 'all' ? null : values.kernels.split(',');
const kernels = kernelPins(tag)
  .filter((k) => !wanted || k.names.some((n) => wanted.includes(n)))
  .map(stageKernel)
  .map((k) => ({ ...k, modules: shadowModules(base, k.enforce, k.version, join(work, 'nm', k.id, 'node_modules')) }));
if (!kernels.length) throw new Error(`no kernel matches --kernels ${values.kernels}`);

for (const tree of [tag, neg]) symlinkSync(kernels[0].modules, join(tree, 'node_modules'));

const stage = {
  name: NAME,
  version,
  prev,
  tools: sh('git', ['rev-parse', 'HEAD'], { cwd: root, quiet: true }).trim(),
  node: process.version,
  subject: { ref, commit: tagCommit },
  prevRef,
  prevCommit,
  source: values.tarball ? 'artifact' : 'npm',
  published: { tarball: pubTgz, sha256: sha('sha256', pubTgz), integrity: sri(pubTgz), dir: pubDir },
  previous: { tarball: prevTgz, sha256: sha('sha256', prevTgz), integrity: sri(prevTgz), dir: prevDir },
  rebuilt,
  kernels: kernels.map(({ id, names, version: v, integrity, sha256, tgz, plain, enforce, modules }) => ({
    id,
    names,
    version: v,
    integrity,
    sha256,
    tgz,
    plain,
    enforce,
    modules,
  })),
  trees: { tag, neg, base },
};
writeFileSync(join(work, 'stage.json'), `${JSON.stringify(stage, null, 2)}\n`);
console.log(
  `stage: ${NAME}@${version} ${stage.published.sha256} (prev ${prev}), kernels ${kernels.map((k) => `${k.id}=${k.version}`).join(' ')}${rebuilt ? `, rebuild ${rebuilt.reproducible ? 'identical' : `differs: ${rebuilt.differingFiles.join(', ')}`}` : ''}`
);
