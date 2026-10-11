import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('runs a .jsh file through binfmt and through #!/usr/bin/jsh', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile('/os/plain.jsh', "console.log('binfmt', process.argv.slice(2).join(','));\n");
      await kernel.writeFile('/os/bang.jsh', "#!/usr/bin/jsh\nconsole.log('shebang', process.argv.slice(2).join(','));\n");
      assert.deepEqual(await run(['/os/plain.jsh', 'a', 'b']), { status: 0, stdout: 'binfmt a,b\n', stderr: '' });
      assert.deepEqual(await run(['/os/bang.jsh', 'c']), { status: 0, stdout: 'shebang c\n', stderr: '' });
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

  /**
   * After `pnpm add -g @ai-ecoverse/slicc-jsh`, PATH often has
   * `~/.local/share/pnpm/bin/jsh` → dist/host/jsh.mjs ahead of slicc.commands.jsh.
   * The host bin must hand off in-process to dist/jsh.mjs (no spawn, no PATH strip).
   */
  it('host bin on jsh node hands off in-process (pnpm global PATH shadow)', async () => {
    const { kernel, run, close } = await withJsh();
    const hostBin = '/node_modules/@ai-ecoverse/slicc-jsh/dist/host/jsh.mjs';
    const pnpmJsh = '/home/.local/share/pnpm/bin/jsh';
    const env = {
      HOME: '/home',
      PNPM_HOME: '/home/.local/share/pnpm',
      PATH: '/home/.local/share/pnpm/bin:/usr/bin:/bin',
    };
    try {
      await kernel.writeFile(pnpmJsh, `#!/usr/bin/env node\nimport ${JSON.stringify(hostBin)};\n`);
      await kernel.writeFile('/os/x.jsh', 'console.log("ok", process.argv.slice(2).join(","));\n');
      await kernel.writeFile(
        '/os/bang.jsh',
        '#!/usr/bin/env jsh\nconsole.log("bang", process.argv.slice(2).join(","));\n'
      );

      assert.deepEqual(await run(['node', hostBin, '--version'], { cwd: '/os', env }), {
        status: 0,
        stdout: `${version}\n`,
        stderr: '',
      });
      assert.deepEqual(await run(['node', hostBin, 'x.jsh', 'a', 'b'], { cwd: '/os', env }), {
        status: 0,
        stdout: 'ok a,b\n',
        stderr: '',
      });
      assert.deepEqual(await run(['node', pnpmJsh, '--version'], { cwd: '/os', env }), {
        status: 0,
        stdout: `${version}\n`,
        stderr: '',
      });
      assert.deepEqual(await run([pnpmJsh, 'x.jsh', 'path'], { cwd: '/os', env }), {
        status: 0,
        stdout: 'ok path\n',
        stderr: '',
      });
      assert.deepEqual(await run(['/os/bang.jsh', 'z'], { cwd: '/os', env }), {
        status: 0,
        stdout: 'bang z\n',
        stderr: '',
      });
      // slicc.commands.jsh still works alongside the PATH bin.
      assert.deepEqual(await run(['jsh', '--version'], { cwd: '/os', env }), {
        status: 0,
        stdout: `${version}\n`,
        stderr: '',
      });
    } finally {
      close();
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
