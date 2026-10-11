/**
 * wasi-pnpm `pnpm add -g` of an ordinary npm JS CLI: the PATH bin is pnpm's
 * cmd shim, which spawn()s node. Requires child_process.spawn on ctx.spawn.
 *
 * The slicc-jsh host-bin shim-path case lives in pnpm-global.test.mjs (hnvq's
 * fix: PR); this file only covers a non-jsh CLI so it can land without handoff.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeKernel, nodeTransport } from '@ai-ecoverse/slicc-kernel/node';
import { createRequire } from 'node:module';
import { packageFiles } from './helpers.mjs';

const require = createRequire(import.meta.url);

function stageDir(kernel, hostDir, dest) {
  const { readdirSync, statSync } = require('node:fs');
  const walk = async (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const target = `${prefix}/${name}`;
      if (statSync(path).isDirectory()) await walk(path, target);
      else await kernel.writeFile(target, readFileSync(path));
    }
  };
  return walk(hostDir, dest);
}

function packTinyCli() {
  const dir = mkdtempSync(join(tmpdir(), 'tiny-cli-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'tiny-cli-cp',
      version: '1.0.0',
      bin: { 'tiny-cli-cp': 'cli.js' },
    })
  );
  writeFileSync(
    join(dir, 'cli.js'),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--fail') process.exit(3);
console.log('tiny', args.join(','));
`
  );
  const tgz = join(dir, 'tiny-cli-cp-1.0.0.tgz');
  execFileSync('npm', ['pack', '--pack-destination', dir], { cwd: dir, stdio: 'pipe' });
  const packed = require('node:fs')
    .readdirSync(dir)
    .find((n) => n.endsWith('.tgz'));
  return { dir, tgz: join(dir, packed) };
}

function resolveWasiPnpm() {
  try {
    return join(require.resolve('@ai-ecoverse/wasi-pnpm/package.json'), '..');
  } catch {
    return null;
  }
}

describe('pnpm add -g JS CLI (child_process shim path)', () => {
  it('root: runs a global bin with args and exit code via pnpm cmd shim', async (t) => {
    const wasiRoot = resolveWasiPnpm();
    if (!wasiRoot) {
      t.skip('@ai-ecoverse/wasi-pnpm not installed');
      return;
    }
    const { dir, tgz } = packTinyCli();
    const kernel = await createNodeKernel({ network: { transport: nodeTransport() } });
    try {
      for (const [rel, data] of packageFiles()) {
        await kernel.writeFile(`/node_modules/@ai-ecoverse/slicc-jsh/${rel}`, data);
      }
      await stageDir(kernel, wasiRoot, '/node_modules/@ai-ecoverse/wasi-pnpm');
      await kernel.writeFile('/os/tiny.tgz', readFileSync(tgz));

      const env = {
        HOME: '/root',
        PNPM_HOME: '/usr/local/share/pnpm',
        PATH: '/usr/local/share/pnpm/bin:/usr/bin:/bin',
      };
      const add = await kernel.run(['pnpm', 'add', '-g', '/os/tiny.tgz'], { cwd: '/os', env });
      assert.equal(add.status, 0, add.stdout + add.stderr);

      const bin = '/usr/local/share/pnpm/bin/tiny-cli-cp';
      const ok = await kernel.run([bin, 'a', 'b'], { cwd: '/os', env });
      assert.equal(ok.status, 0, ok.stdout + ok.stderr);
      assert.equal(ok.stdout, 'tiny a,b\n');

      const fail = await kernel.run([bin, '--fail'], { cwd: '/os', env });
      assert.equal(fail.status, 3, fail.stdout + fail.stderr);
    } finally {
      kernel.terminate();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cone user: pnpm add -g into the user PNPM_HOME', async (t) => {
    const wasiRoot = resolveWasiPnpm();
    if (!wasiRoot) {
      t.skip('@ai-ecoverse/wasi-pnpm not installed');
      return;
    }
    if (typeof createNodeKernel !== 'function') {
      t.skip('no createNodeKernel');
      return;
    }
    const { dir, tgz } = packTinyCli();
    const kernel = await createNodeKernel({ network: { transport: nodeTransport() } });
    try {
      if (typeof kernel.users?.add !== 'function') {
        t.skip('kernel.users.add unavailable (need slicc-kernel ≥ 1.56.0)');
        return;
      }
      for (const [rel, data] of packageFiles()) {
        await kernel.writeFile(`/node_modules/@ai-ecoverse/slicc-jsh/${rel}`, data);
      }
      await stageDir(kernel, wasiRoot, '/node_modules/@ai-ecoverse/wasi-pnpm');
      await kernel.writeFile('/home/cone/tiny.tgz', readFileSync(tgz));

      const user = await kernel.users.add({ name: 'cone' });
      assert.equal(user.name, 'cone');
      const env = {
        // kernel.run({ user }) also sets HOME/PNPM_HOME/PATH; keep explicit for clarity.
        HOME: user.home,
        PNPM_HOME: `${user.home}/.local/share/pnpm`,
        PATH: `${user.home}/.local/share/pnpm/bin:/usr/bin:/bin`,
      };
      const add = await kernel.run(['pnpm', 'add', '-g', '/home/cone/tiny.tgz'], {
        cwd: user.home,
        user: 'cone',
        env,
      });
      assert.equal(add.status, 0, add.stdout + add.stderr);

      const bin = `${user.home}/.local/share/pnpm/bin/tiny-cli-cp`;
      const ok = await kernel.run([bin, 'u'], { cwd: user.home, user: 'cone', env });
      assert.equal(ok.status, 0, ok.stdout + ok.stderr);
      assert.equal(ok.stdout, 'tiny u\n');
    } finally {
      kernel.terminate();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
