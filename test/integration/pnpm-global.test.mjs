/**
 * slicc-jsh installed globally with the kernel's wasi-pnpm (`pnpm add -g`),
 * as seven does. pnpm links the package's npm `bin` (the host CLI,
 * dist/host/jsh.mjs) into $PNPM_HOME/bin, which shadows the kernel's `jsh`
 * command on PATH. The host CLI must hand off to the kernel jsh there.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '@ai-ecoverse/slicc-kernel/node';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

// argv[0] 'jsh' and a working sliccy:exec (ctx.spawn) only exist in the kernel jsh.
const SCRIPT = `const exec = require('sliccy:exec');
const r = await exec.spawn(['node', '-e', 'console.log(6 * 7)']);
console.log(process.argv[0], process.argv.slice(2).join(','), r.exitCode, r.stdout.trim());
`;
const EXPECTED = 'jsh a,b 0 42\n';

async function stage(kernel, dir, dest) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) await stage(kernel, path, `${dest}/${name}`);
    else await kernel.writeFile(`${dest}/${name}`, readFileSync(path));
  }
}

const withTimeout = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: timeout after ${ms}ms`)), ms)),
  ]);

describe('pnpm add -g @ai-ecoverse/slicc-jsh in the kernel', () => {
  let kernel;
  let packDir;
  let hostCli;
  let globalBin;
  const run = (argv, ms = 60_000) => withTimeout(kernel.run(argv, { cwd: '/os' }), ms, argv.join(' '));

  before(async () => {
    packDir = mkdtempSync(join(tmpdir(), 'jsh-pack-'));
    execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', packDir], { cwd: root, stdio: 'pipe' });
    const tgz = readdirSync(packDir).find((n) => n.endsWith('.tgz'));
    kernel = await createNodeKernel();
    const pnpmDir = dirname(require.resolve('@ai-ecoverse/wasi-pnpm/package.json'));
    await stage(kernel, pnpmDir, '/node_modules/@ai-ecoverse/wasi-pnpm');
    await kernel.writeFile('/os/slicc-jsh.tgz', readFileSync(join(packDir, tgz)));
    await kernel.writeFile('/os/x.jsh', SCRIPT);
    const add = await run(['pnpm', 'add', '-g', '/os/slicc-jsh.tgz'], 300_000);
    assert.equal(add.status, 0, add.stderr || add.stdout);
    globalBin = (await run(['pnpm', 'bin', '-g'])).stdout.trim();
    assert.match(globalBin, /^\//);
    // The bin shim names its target: `// pnpm-wasm-shim={"target":"../global/…/dist/host/jsh.mjs",…}`.
    const shim = new TextDecoder().decode(await kernel.readFile(`${globalBin}/jsh`));
    const target = JSON.parse(/pnpm-wasm-shim=(\{.*\})/.exec(shim)[1]).target;
    assert.match(target, /@ai-ecoverse\/slicc-jsh\/dist\/host\/jsh\.mjs$/);
    hostCli = posix.resolve(globalBin, target);
  });

  after(() => {
    kernel?.terminate();
    if (packDir) rmSync(packDir, { recursive: true, force: true });
  });

  it('runs the kernel jsh from the catalog', async () => {
    assert.deepEqual(await run(['jsh', 'x.jsh', 'a', 'b']), { status: 0, stdout: EXPECTED, stderr: '' });
  });

  it('hands off from the host CLI to the kernel jsh under the kernel node', async () => {
    const cli = hostCli;
    assert.deepEqual(await run(['node', cli, 'x.jsh', 'a', 'b']), { status: 0, stdout: EXPECTED, stderr: '' });
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    assert.deepEqual(await run(['node', cli, '--version']), { status: 0, stdout: `${version}\n`, stderr: '' });
  });

  it('runs jsh through pnpm\'s global bin shim (the PATH entry)', {
    skip: 'the shim spawns node through child_process (slicc-jsh#58 un-skips this)',
  }, async () => {
    assert.deepEqual(await run([`${globalBin}/jsh`, 'x.jsh', 'a', 'b']), { status: 0, stdout: EXPECTED, stderr: '' });
  });
});
