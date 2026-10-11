/**
 * Run scripts/raw-ctx-net-fin.mjs as a raw abi:js command on one or more
 * slicc-kernel versions (no jsh net.mjs in the path).
 *
 *   node scripts/run-raw-ctx-net-fin.mjs
 *   node scripts/run-raw-ctx-net-fin.mjs 1.53.1 1.54.0
 *
 * Kernels are unpacked under /tmp/slicc-kernel-versions/ from npm pack tarballs
 * (or use the in-tree node_modules copy for the current version).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rawSource = readFileSync(join(root, 'scripts/raw-ctx-net-fin.mjs'), 'utf8');
const cache = '/tmp/slicc-kernel-versions';
const versions = process.argv.slice(2);
const wanted = versions.length ? versions : ['1.53.1', '1.54.0'];

async function ensureKernel(version) {
  const dir = join(cache, version);
  const marker = join(dir, 'package/package.json');
  if (existsSync(marker)) {
    const pkg = JSON.parse(readFileSync(marker, 'utf8'));
    if (pkg.version === version) return join(dir, 'package');
  }
  await mkdir(cache, { recursive: true });
  const tgz = join(cache, `ai-ecoverse-slicc-kernel-${version}.tgz`);
  if (!existsSync(tgz)) {
    const { execFileSync } = await import('node:child_process');
    execFileSync('npm', ['pack', `@ai-ecoverse/slicc-kernel@${version}`], {
      cwd: cache,
      stdio: 'inherit',
    });
  }
  const hash = createHash('sha256').update(readFileSync(tgz)).digest('hex');
  console.log(`kernel ${version} tarball sha256 ${hash}`);
  await rm(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const { execFileSync } = await import('node:child_process');
  execFileSync('tar', ['-xzf', tgz, '-C', dir], { stdio: 'inherit' });
  return join(dir, 'package');
}

async function runOn(kernelPkgPath, version) {
  const { createNodeKernel } = await import(join(kernelPkgPath, 'dist/node.js'));
  const kernel = await createNodeKernel();
  try {
    const base = '/node_modules/raw-ctx-net-fin';
    await kernel.writeFile(
      `${base}/package.json`,
      JSON.stringify({
        name: 'raw-ctx-net-fin',
        version: '0.0.0',
        slicc: {
          commands: {
            'raw-fin': { abi: 'js', module: 'raw-ctx-net-fin.mjs', argv0: 'raw-fin' },
          },
        },
      })
    );
    await kernel.writeFile(`${base}/raw-ctx-net-fin.mjs`, rawSource);

    const out = { version, kernelPkg: kernelPkgPath };
    for (const mode of ['writer-close', 'conn-close']) {
      const result = await kernel.run(['raw-fin', mode], { cwd: '/os' });
      out[mode] = {
        status: result.status,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim().slice(0, 240),
      };
    }
    return out;
  } finally {
    kernel.terminate();
  }
}

const results = [];
for (const version of wanted) {
  let pkgPath;
  if (version === 'in-tree') {
    pkgPath = join(root, 'node_modules/@ai-ecoverse/slicc-kernel');
  } else {
    pkgPath = await ensureKernel(version);
  }
  const pkg = JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8'));
  console.log(`\n=== slicc-kernel ${pkg.version} (${pkgPath}) ===`);
  const row = await runOn(pkgPath, pkg.version);
  results.push(row);
  console.log(JSON.stringify(row, null, 2));
}

console.log('\n=== summary ===');
for (const row of results) {
  for (const mode of ['writer-close', 'conn-close']) {
    const line = row[mode]?.stdout || '';
    const kind = line.startsWith('DONE') ? 'DONE' : line.startsWith('TIMEOUT') ? 'TIMEOUT' : '?';
    console.log(`${row.version} ${mode}: ${kind} (${line})`);
  }
}
