import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withJsh } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hostJsh = join(root, 'dist/host/jsh.mjs');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

/** A package with a `slicc` export condition: the kernel picks it, host Node never does. */
const conditionPackage = {
  'node_modules/@ai-ecoverse/sliccy-where/package.json': JSON.stringify({
    name: '@ai-ecoverse/sliccy-where',
    exports: { slicc: './kernel.js', default: './host.js' },
  }),
  'node_modules/@ai-ecoverse/sliccy-where/kernel.js': "module.exports = 'kernel';\n",
  'node_modules/@ai-ecoverse/sliccy-where/host.js': "module.exports = 'host';\n",
  'where.jsh': "console.log(require('sliccy:where'));\n",
};

/**
 * pnpm's global layout, as `pnpm add -g` leaves it: an older pnpm ≤ 10
 * global/5, and pnpm ≥ 11 groups (one per add) with their 64-hex links. As
 * for the kernel's commands, the first group in sorted order wins;
 * `sliccy-older` is only in the pnpm ≤ 10 one.
 */
function pnpmHome(dir) {
  const pkg = (base, name, value) => {
    const at = join(dir, base, 'node_modules', name);
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
    writeFileSync(join(at, 'index.js'), `module.exports = ${JSON.stringify(value)};\n`);
  };
  pkg('global/v11/1-18de50e4fd642380-0', '@ai-ecoverse/sliccy-hello', 'first group');
  pkg('global/v11/1-18de50e530a6b280-0', '@ai-ecoverse/sliccy-hello', 'second group');
  pkg('global/v11/1-18de50e530a6b280-0', 'sliccy-plain', 'unscoped');
  pkg('global/5', 'sliccy-older', 'pnpm 10');
  symlinkSync(join(dir, 'global/v11/1-18de50e4fd642380-0'), join(dir, 'global/v11', 'a'.repeat(64)));
  writeFileSync(join(dir, 'global.jsh'), "console.log(['hello', 'plain', 'older'].map((n) => require('sliccy:' + n)).join('|'));\n");
}
const GLOBAL_OUT = 'first group|unscoped|pnpm 10\n';

describe('kernel jsh', () => {
  it('prints its version and usage', async () => {
    const { run, close } = await withJsh();
    try {
      assert.deepEqual(await run(['jsh', '--version']), { status: 0, stdout: `${version}\n`, stderr: '' });
      assert.equal((await run(['jsh', '--help'])).status, 0);
      const bad = await run(['jsh', '--nope']);
      assert.equal(bad.status, 9);
      assert.match(bad.stderr, /^jsh: bad option: --nope\n/);
      const missing = await run(['jsh', 'missing.jsh']);
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /^jsh: cannot open \/os\/missing\.jsh: /);
    } finally {
      close();
    }
  });

  // As on Linux, running a script by path (binfmt or #!) needs its x bit
  // (slicc-kernel 1.78.0+). A file kernel.writeFile writes is 0644, and
  // neither the embedder nor a JS program can chmod yet
  // (ai-ecoverse/slicc-kernel#495), so the runnable fixtures sit where the
  // kernel's default mode is 0755: a package's bin/.
  it('runs a .jsh file through binfmt and through #!/usr/bin/jsh', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      const bin = '/node_modules/jsh-fixtures/bin';
      await kernel.writeFile(`${bin}/plain.jsh`, "console.log('binfmt', process.argv.slice(2).join(','));\n");
      await kernel.writeFile(`${bin}/bang.jsh`, "#!/usr/bin/jsh\nconsole.log('shebang', process.argv.slice(2).join(','));\n");
      assert.deepEqual(await run([`${bin}/plain.jsh`, 'a', 'b']), { status: 0, stdout: 'binfmt a,b\n', stderr: '' });
      assert.deepEqual(await run([`${bin}/bang.jsh`, 'c']), { status: 0, stdout: 'shebang c\n', stderr: '' });
    } finally {
      close();
    }
  });

  it('a .jsh file without its x bit is not run by path (EACCES), but jsh <file> runs it', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile('/os/noexec.jsh', "console.log('read by jsh');\n");
      await kernel.writeFile('/os/noexec-bang.jsh', "#!/usr/bin/jsh\nconsole.log('read by jsh');\n");
      for (const file of ['/os/noexec.jsh', '/os/noexec-bang.jsh']) {
        await assert.rejects(run([file]), (err) => err.code === 'EACCES', file);
      }
      assert.deepEqual(await run(['jsh', 'noexec.jsh']), { status: 0, stdout: 'read by jsh\n', stderr: '' });
    } finally {
      close();
    }
  });

  it('resolves the slicc export condition for sliccy-* packages', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      for (const [rel, text] of Object.entries(conditionPackage)) await kernel.writeFile(`/os/${rel}`, text);
      assert.deepEqual(await run(['jsh', 'where.jsh']), { status: 0, stdout: 'kernel\n', stderr: '' });
    } finally {
      close();
    }
  });

  it("finds a sliccy-* package in pnpm's global installs (PNPM_HOME), each pnpm add -g its own group", async () => {
    const { kernel, run, close } = await withJsh();
    const dir = mkdtempSync(join(tmpdir(), 'jsh-pnpm-home-'));
    try {
      pnpmHome(dir);
      // kernel.writeFile has no symlinks; the link is left out here.
      const walk = async (at, to) => {
        for (const entry of (await import('node:fs')).readdirSync(at, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) await walk(join(at, entry.name), `${to}/${entry.name}`);
          else await kernel.writeFile(`${to}/${entry.name}`, readFileSync(join(at, entry.name)));
        }
      };
      await walk(dir, '/srv/pnpm');
      const r = await run(['jsh', '/srv/pnpm/global.jsh'], { env: { PNPM_HOME: '/srv/pnpm' } });
      assert.deepEqual(r, { status: 0, stdout: GLOBAL_OUT, stderr: '' });
    } finally {
      close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('host jsh', () => {
  const runHost = (args, cwd) =>
    spawnSync(process.execPath, [hostJsh, ...args], { cwd, encoding: 'utf8', timeout: 30_000 });

  it('ignores the slicc export condition', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsh-host-'));
    try {
      for (const [rel, text] of Object.entries(conditionPackage)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), text);
      }
      const r = runHost(['where.jsh'], dir);
      assert.equal(r.stderr, '');
      assert.equal(r.stdout, 'host\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds a sliccy-* package in pnpm's global installs (PNPM_HOME)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsh-pnpm-home-'));
    try {
      pnpmHome(dir);
      const r = spawnSync(process.execPath, [hostJsh, 'global.jsh'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, PNPM_HOME: dir },
      });
      assert.equal(r.stderr, '');
      assert.equal(r.stdout, GLOBAL_OUT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs as an executable with #!/usr/bin/env jsh', { skip: process.platform === 'win32' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsh-host-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'jsh'), `#!/bin/sh\nexec "${process.execPath}" "${hostJsh}" "$@"\n`, { mode: 0o755 });
      writeFileSync(join(dir, 'tool.jsh'), "#!/usr/bin/env jsh\nconsole.log('tool', process.argv.parseFlags().flags.n);\n", {
        mode: 0o755,
      });
      const r = spawnSync(join(dir, 'tool.jsh'), ['--n', '3'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      assert.equal(r.stderr, '');
      assert.equal(r.stdout, 'tool 3\n');
      assert.equal(r.status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
