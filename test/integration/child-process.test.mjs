import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

/** Run a node -e script that exercises child_process; return {status,stdout,stderr}. */
async function cp(run, source) {
  return run(['node', '-e', source], { cwd: '/os' });
}

describe('child_process (ctx.spawn)', () => {
  it('spawn: pipe stdio, exit code, spawn/exit/close events', async () => {
    const { run, close } = await withJsh();
    try {
      const r = await cp(
        run,
        `
const { spawn } = require('child_process');
const c = spawn('node', ['-e', 'process.stdout.write("hi\\\\n"); process.exit(7)'], { stdio: ['ignore','pipe','pipe'] });
let out = '';
c.stdout.on('data', (d) => { out += d; });
const ev = [];
c.on('spawn', () => ev.push('spawn:' + typeof c.pid));
c.on('exit', (code, sig) => ev.push('exit:' + code + ':' + sig));
c.on('close', (code, sig) => {
  ev.push('close:' + code + ':' + sig);
  console.log(JSON.stringify({ out, ev, pid: c.pid }));
});
`
      );
      assert.equal(r.status, 0, r.stderr);
      const j = JSON.parse(r.stdout.trim());
      assert.equal(j.out, 'hi\n');
      assert.match(j.ev[0], /^spawn:number$/);
      assert.ok(j.ev.includes('exit:7:null'));
      assert.ok(j.ev.includes('close:7:null'));
      assert.equal(typeof j.pid, 'number');
    } finally {
      close();
    }
  });

  it('spawn: ENOENT emits error then close(-2), no exit', async () => {
    const { run, close } = await withJsh();
    try {
      const r = await cp(
        run,
        `
const { spawn } = require('child_process');
const c = spawn('no-such-cmd-xyz-abc', []);
const ev = [];
c.on('spawn', () => ev.push('spawn'));
c.on('exit', () => ev.push('exit'));
c.on('error', (e) => ev.push('error:' + e.code));
c.on('close', (code, sig) => {
  ev.push('close:' + code + ':' + sig);
  console.log(JSON.stringify(ev));
});
`
      );
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout.trim()), ['error:ENOENT', 'close:-2:null']);
    } finally {
      close();
    }
  });

  it("spawn ENOENT: its 'close' comes after every spawn its 'error' handler started has reported, as in Node", async () => {
    // Node's spawn() is synchronous, and a failed spawn's 'close' comes on
    // the next loop turn: 20 execFile()s of a missing command from the
    // 'error' handler have all called back by then. On a kernel without
    // ctx.sync.spawn (before 1.87.0) jsh's spawns settle later, and the
    // 'close' came after a fixed 20 ms: on 1.86.0, after 0 of the 20
    // (cp/enoent.js flipped under load, ai-ecoverse/slicc-jsh#236).
    const { run, close } = await withJsh();
    try {
      const r = await cp(
        run,
        `
const { spawn, execFile } = require('child_process');
let n = 0;
const c = spawn('definitely-not-a-cmd-xyz', ['a']);
c.on('error', () => { for (let i = 0; i < 20; i++) execFile('definitely-not-a-cmd-xyz', () => n++); });
c.on('close', (code) => console.log('close', code, 'after', n));
`
      );
      assert.equal(r.stdout, 'close -2 after 20\n');
    } finally {
      close();
    }
  });

  it('spawn: SIGTERM kill → exit(null, SIGTERM)', async () => {
    const { run, close } = await withJsh();
    try {
      const r = await cp(
        run,
        `
const { spawn } = require('child_process');
const c = spawn('node', ['-e', 'setTimeout(()=>{}, 1e9)'], { stdio: 'ignore' });
c.on('spawn', () => setTimeout(() => c.kill('SIGTERM'), 50));
c.on('exit', (code, sig) => {
  console.log(JSON.stringify({ code, sig, killed: c.killed }));
});
`
      );
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout.trim()), { code: null, sig: 'SIGTERM', killed: true });
    } finally {
      close();
    }
  });

  it('execFile: collects stdout and maps non-zero exit', async () => {
    const { run, close } = await withJsh();
    try {
      const r = await cp(
        run,
        `
const { execFile } = require('child_process');
execFile('node', ['-e', 'console.log("x"); process.exit(3)'], { encoding: 'utf8' }, (err, stdout, stderr) => {
  console.log(JSON.stringify({
    errCode: err && err.code,
    stdout,
    hasStderr: typeof stderr === 'string',
  }));
});
`
      );
      assert.equal(r.status, 0, r.stderr);
      const j = JSON.parse(r.stdout.trim());
      assert.equal(j.errCode, 3);
      assert.equal(j.stdout, 'x\n');
      assert.equal(j.hasStderr, true);
    } finally {
      close();
    }
  });

  it('missing or non-directory cwd fails like Node (ENOENT / ENOTDIR)', async () => {
    // Cert fx/m9/relcwd2.js: missing cwd → ENOENT on error; file-as-cwd → throw ENOTDIR.
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile('/os/w-rc2/a/m', 'A');
      const r = await cp(
        run,
        `
const { spawn, execFile } = require('child_process');
const rows = [];
const runSpawn = (cwd) => new Promise((resolve) => {
  try {
    const c = spawn('node', ['-e', 'process.exit(0)'], { cwd, stdio: 'ignore' });
    c.on('error', (e) => resolve({ kind: 'error', code: e.code, syscall: e.syscall, path: e.path }));
    c.on('close', (code) => resolve({ kind: 'close', code }));
  } catch (e) {
    resolve({ kind: 'throw', code: e.code, syscall: e.syscall, path: e.path, errno: e.errno });
  }
});
const runExec = (cwd) => new Promise((resolve) => {
  try {
    execFile('node', ['-e', 'process.exit(0)'], { cwd }, (e) => {
      resolve(e ? { kind: 'cb', code: e.code, syscall: e.syscall, path: e.path } : { kind: 'ok' });
    });
  } catch (e) {
    resolve({ kind: 'throw', code: e.code, syscall: e.syscall, errno: e.errno });
  }
});
(async () => {
  rows.push(['missing', await runSpawn('w-rc2/nope'), await runExec('w-rc2/nope')]);
  rows.push(['abs', await runSpawn('/nonexistent-zz/abs'), await runExec('/nonexistent-zz/abs')]);
  rows.push(['file', await runSpawn('w-rc2/a/m'), await runExec('w-rc2/a/m')]);
  console.log(JSON.stringify(rows));
})();
`
      );
      assert.equal(r.status, 0, r.stderr);
      const rows = JSON.parse(r.stdout.trim());
      const by = Object.fromEntries(rows.map(([k, sp, ef]) => [k, { sp, ef }]));
      assert.equal(by.missing.sp.kind, 'error');
      assert.equal(by.missing.sp.code, 'ENOENT');
      assert.equal(by.missing.sp.syscall, 'spawn node');
      assert.equal(by.missing.sp.path, 'node');
      assert.equal(by.missing.ef.kind, 'cb');
      assert.equal(by.missing.ef.code, 'ENOENT');
      assert.equal(by.abs.sp.code, 'ENOENT');
      assert.equal(by.abs.ef.code, 'ENOENT');
      assert.equal(by.file.sp.kind, 'throw');
      assert.equal(by.file.sp.code, 'ENOTDIR');
      assert.equal(by.file.sp.syscall, 'spawn');
      assert.equal(by.file.sp.errno, -20);
      assert.equal(by.file.ef.kind, 'throw');
      assert.equal(by.file.ef.code, 'ENOTDIR');
    } finally {
      close();
    }
  });

  it('relative cwd resolves against process.cwd(), not /', async () => {
    // Cert fx/m9/relcwd.js: execFile(..., { cwd: 'w-rc/sub' }) must run in $CWD/w-rc/sub.
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile('/os/w-rc/sub/marker', 'here');
      const r = await cp(
        run,
        `
const { execFile } = require('child_process');
const mask = (s) => String(s).split(process.cwd()).join('CWD');
execFile(
  'node',
  ['-e', 'process.stdout.write(process.cwd()+"\\\\n"+require("fs").readFileSync("marker","utf8"))'],
  { cwd: 'w-rc/sub' },
  (err, stdout, stderr) => {
    console.log(JSON.stringify({
      err: err && err.code,
      out: mask(stdout),
      errOut: mask(stderr).slice(0, 80),
    }));
  }
);
`
      );
      assert.equal(r.status, 0, r.stderr);
      const j = JSON.parse(r.stdout.trim());
      assert.equal(j.err, null);
      assert.equal(j.out, 'CWD/w-rc/sub\nhere');
    } finally {
      close();
    }
  });

  it('util.promisify(exec|execFile) resolves to { stdout, stderr }', async () => {
    // Without promisify.custom, default promisify yields [stdout, stderr] and
    // `const { stdout } = await …` is undefined (seven child-process-async).
    const { run, close } = await withJsh();
    try {
      const r = await cp(
        run,
        `
const cp = require('child_process');
const { promisify } = require('util');
const custom = promisify.custom;
const pFile = promisify(cp.execFile)('node', ['-e', 'process.stdout.write("ef\\\\n")']);
// Prefer bash: bare memory root has /usr/bin/bash but often no sh.
const pExec = promisify(cp.exec)('echo promised', { shell: 'bash' });
Promise.allSettled([pFile, pExec]).then(([f, e]) => {
  const b = f.status === 'fulfilled' ? f.value : null;
  const a = e.status === 'fulfilled' ? e.value : null;
  console.log(JSON.stringify({
    hasExecCustom: typeof cp.exec[custom] === 'function',
    hasFileCustom: typeof cp.execFile[custom] === 'function',
    fileStdout: b && b.stdout,
    fileKeys: b && Object.keys(b).sort(),
    child: !!pFile.child,
    execStdout: a && a.stdout,
    execKeys: a && Object.keys(a).sort(),
    execChild: !!pExec.child,
    execErr: e.status === 'rejected' ? e.reason && e.reason.code : null,
  }));
});
`
      );
      assert.equal(r.status, 0, r.stderr);
      const j = JSON.parse(r.stdout.trim());
      assert.equal(j.hasExecCustom, true);
      assert.equal(j.hasFileCustom, true);
      assert.equal(j.fileStdout, 'ef\n');
      assert.deepEqual(j.fileKeys, ['stderr', 'stdout']);
      assert.equal(j.child, true);
      if (j.execErr) {
        assert.equal(j.execErr, 'ENOENT');
      } else {
        assert.equal(j.execStdout, 'promised\n');
        assert.deepEqual(j.execKeys, ['stderr', 'stdout']);
        assert.equal(j.execChild, true);
      }
    } finally {
      close();
    }
  });

  it('exec: uses /bin/sh; ENOENT message/path match Node', async () => {
    // Cert: Node says `spawn /bin/sh`, not `spawn sh`.
    const { run, close } = await withJsh();
    try {
      const r = await cp(
        run,
        `
const { exec } = require('child_process');
exec('true', { encoding: 'utf8', cwd: '/nonexistent-zz-exec-shell' }, (err, stdout) => {
  console.log(JSON.stringify({
    code: err && err.code,
    path: err && err.path,
    syscall: err && err.syscall,
    message: err && err.message,
    spawnargs: err && err.spawnargs,
    stdout: stdout == null ? null : String(stdout),
  }));
});
`
      );
      assert.equal(r.status, 0, r.stderr);
      const j = JSON.parse(r.stdout.trim());
      assert.equal(j.code, 'ENOENT');
      assert.equal(j.path, '/bin/sh');
      assert.equal(j.syscall, 'spawn /bin/sh');
      assert.equal(j.message, 'spawn /bin/sh ENOENT');
      assert.deepEqual(j.spawnargs, ['-c', 'true']);
    } finally {
      close();
    }
  });

  it('fork is ERR_NOT_SUPPORTED without an IPC channel from the kernel; the sync forms run on ctx.sync.run', async () => {
    const { run, close } = await withJsh();
    try {
      const r = await cp(
        run,
        `
const cp = require('child_process');
const out = [];
for (const name of ['spawnSync', 'execSync', 'execFileSync', 'fork']) {
  try { const r = cp[name]('x'); out.push(name + ':' + (r && r.error ? r.error.code : 'ok')); }
  catch (e) { out.push(name + ':' + e.code); }
}
console.log(out.join(' '));
`
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(
        r.stdout.trim(),
        // No /bin/sh in this kernel (no wasm-bash), so execSync is ENOENT too.
        // With the channel (ai-ecoverse/slicc-kernel#1093), fork starts a node
        // child (which can't find 'x': that's its own error).
        `spawnSync:ENOENT execSync:ENOENT execFileSync:ENOENT fork:${'ok'}`
      );
    } finally {
      close();
    }
  });

  it('process.execPath is the resolved node bin; spawn(execPath) works', async () => {
    // npm-run-all / cross-spawn / many test runners re-spawn via process.execPath.
    // dist/node.mjs is not executable (ENOEXEC flat / ENOENT under pnpm -g).
    const { run, close } = await withJsh();
    try {
      const r = await cp(
        run,
        `
const { spawn } = require('child_process');
const fs = require('fs');
const path = process.execPath;
if (typeof path !== 'string' || !path.startsWith('/') || !path.endsWith('/node')) {
  console.log(JSON.stringify({ ok: false, path, reason: 'shape' }));
  process.exit(0);
}
if (path.includes('slicc-jsh') || path.endsWith('.mjs')) {
  console.log(JSON.stringify({ ok: false, path, reason: 'shim-path' }));
  process.exit(0);
}
if (!fs.existsSync(path)) {
  console.log(JSON.stringify({ ok: false, path, reason: 'missing' }));
  process.exit(0);
}
const c = spawn(path, ['-e', 'console.log("from-execPath"); process.exit(0)']);
let out = '';
let errCode = null;
c.stdout.on('data', (d) => { out += d; });
c.on('error', (e) => { errCode = e.code; });
c.on('close', (code) => {
  console.log(JSON.stringify({ ok: errCode == null && code === 0 && out.trim() === 'from-execPath', path, code, out: out.trim(), errCode }));
});
`
      );
      assert.equal(r.status, 0, r.stderr);
      const j = JSON.parse(r.stdout.trim());
      assert.equal(j.ok, true, JSON.stringify(j));
      assert.equal(j.path, '/usr/bin/node');
    } finally {
      close();
    }
  });

  it('stdio inherit: pnpm-shim shape (spawn node script, exit code)', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      await kernel.writeFile('/os/cli.mjs', 'console.log("cli", process.argv.slice(2).join(",")); process.exit(0);\n');
      const r = await cp(
        run,
        `
const { spawn } = require('child_process');
const c = spawn('node', ['/os/cli.mjs', 'a', 'b'], { stdio: 'inherit' });
c.on('exit', (code) => { process.exitCode = code ?? 1; });
`
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'cli a,b\n');
    } finally {
      close();
    }
  });

  it('pipe stdio works when dist/vendor is absent (embedded vendor; pnpm global)', async () => {
    // Seven: package lives under $PNPM_HOME/global/v11/<hash>/, not
    // /node_modules/@ai-ecoverse/slicc-jsh. getStream() must not sync-read the
    // hardcoded /node_modules/.../dist/vendor/readable-stream.cjs path.
    const { createNodeKernel, nodeTransport } = await import('@ai-ecoverse/slicc-kernel/node');
    const { packageFiles } = await import('./helpers.mjs');
    const kernel = await createNodeKernel({ network: { transport: nodeTransport() } });
    const base = '/node_modules/@ai-ecoverse/slicc-jsh';
    try {
      for (const [rel, data] of packageFiles()) {
        if (rel.startsWith('dist/vendor/')) continue;
        await kernel.writeFile(`${base}/${rel}`, data);
      }
      const r = await kernel.run(
        [
          'node',
          '-e',
          `
const { execFile } = require('child_process');
execFile('node', ['-e', 'process.exit(7)'], (e) => {
  console.log('cb', e && e.code);
  process.exit(0);
});
setTimeout(() => {}, 5000);
`,
        ],
        { cwd: '/os' }
      );
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.equal(r.stdout.trim(), 'cb 7');
      assert.equal(r.stderr, '');
    } finally {
      kernel.terminate();
    }
  });
});
