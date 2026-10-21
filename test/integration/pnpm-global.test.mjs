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

// The timer is cleared (and unref'd) so it never keeps the test process alive.
async function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: timeout after ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

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

  it('runs jsh through pnpm\'s global bin shim (the PATH entry)', async () => {
    assert.deepEqual(await run([`${globalBin}/jsh`, 'x.jsh', 'a', 'b']), { status: 0, stdout: EXPECTED, stderr: '' });
  });

  it('piped child_process works from the global/v11 install (no /node_modules package)', async () => {
    // Seven regression: getStream() used to sync-read
    // /node_modules/@ai-ecoverse/slicc-jsh/dist/vendor/readable-stream.cjs, which
    // does not exist after pnpm add -g (package is under $PNPM_HOME/global/v11/).
    assert.match(hostCli, /\/global\/v11\//);
    const missing = await run([
      'node',
      '-e',
      `const fs=require('fs'); console.log(fs.existsSync('/node_modules/@ai-ecoverse/slicc-jsh'))`,
    ]);
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(missing.stdout.trim(), 'false');

    const r = await run([
      'node',
      '-e',
      `require('child_process').execFile('node',['-e','process.exit(7)'],(e)=>{console.log('cb',e&&e.code); process.exit(0)}); setTimeout(()=>{},5000)`,
    ]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.equal(r.stdout.trim(), 'cb 7');
    assert.equal(r.stderr, '');
  });

  it('Brotli and Zstd compress from the global/v11 install: their WebAssembly is read from it', async () => {
    const r = await run([
      'node',
      '-e',
      `const z=require('zlib'); const s='global '.repeat(100); console.log(z.brotliDecompressSync(z.brotliCompressSync(s)).toString()===s, z.zstdDecompressSync(z.zstdCompressSync(s)).toString()===s)`,
    ]);
    assert.deepEqual(r, { status: 0, stdout: 'true true\n', stderr: '' });
  });
});
