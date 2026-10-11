/**
 * MUST regressions from the 0.3.0 cert FAIL (vhnh fx/cp + process.exit in
 * ChildProcess handlers). Uses `node` instead of coreutils so the memory-root
 * CI kernel can run them; vhnh's fx/cp still exercises sh/sleep/echo.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

async function cp(run, source, opts) {
  return run(['node', '-e', source], { cwd: '/os', ...opts });
}

describe('slicc-jsh 0.3.0 child_process Node parity (MUST)', () => {
  it('execFile/exec callbacks default to utf8 strings (cp/execfile.js)', async () => {
    const { run, close } = await withJsh();
    try {
      const r = await cp(
        run,
        `
const { execFile, exec } = require('child_process');
execFile('node', ['-e', 'process.stdout.write("a b c\\\\n")'], (err, stdout, stderr) => {
  console.log('execFile echo', err, JSON.stringify(stdout), typeof stdout, typeof stderr);
  execFile('node', ['-e', 'process.stdout.write("x\\\\n"); process.exit(7)'], (err2, so) => {
    console.log('execFile exit 7', err2 && err2.code, err2 && err2.killed, err2 && err2.signal, JSON.stringify(so), typeof so);
  });
});
`
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /execFile echo null "a b c\\n" string string/);
      assert.match(r.stdout, /execFile exit 7 7 false null "x\\n" string/);
    } finally {
      close();
    }
  });

  it('process.exit(n) in ChildProcess exit handler exits with n (cp/exitprop.js)', async () => {
    const { run, close } = await withJsh();
    try {
      const r = await cp(
        run,
        `
const { spawn } = require('child_process');
spawn('node', ['-e', 'process.exit(5)'], { stdio: 'inherit' }).on('exit', (code) => {
  console.log('child exit', code, '-> process.exit');
  process.exit(code);
});
`
      );
      assert.equal(r.status, 5, r.stderr);
      assert.doesNotMatch(r.stderr, /Process exited with code/);
      assert.match(r.stdout, /child exit 5/);
    } finally {
      close();
    }
  });

  it('process.kill(pid, 0) is a liveness check (cp/selfkill.js)', async () => {
    const { run, close } = await withJsh();
    try {
      const r = await cp(
        run,
        `
console.log('kill(self, 0) ->', process.kill(process.pid, 0));
try { process.kill(process.pid + 99999, 0); console.log('dead ok'); }
catch (e) { console.log('dead', e.code); }
process.exit(0);
`
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /kill\(self, 0\) -> true/);
      assert.match(r.stdout, /dead ESRCH/);
    } finally {
      close();
    }
  });

  it('child.kill() after exit returns false (cp/killexited.js)', async () => {
    const { run, close } = await withJsh();
    try {
      const r = await cp(
        run,
        `
const { spawn } = require('child_process');
const c = spawn('node', ['-e', 'process.exit(0)']);
c.on('exit', () => {
  setTimeout(() => {
    try { console.log('kill after exit ->', c.kill()); }
    catch (e) { console.log('kill after exit threw', e.code, e.message); }
  }, 50);
});
`
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /kill after exit -> false/);
      assert.doesNotMatch(r.stdout, /threw/);
    } finally {
      close();
    }
  });

  it('getuid/geteuid/getgid/getgroups report kernel creds (cp/ids.js)', async () => {
    const { kernel, run, close } = await withJsh();
    try {
      const src = `
console.log(JSON.stringify({
  getuid: process.getuid(),
  geteuid: process.geteuid(),
  getgid: process.getgid(),
  getegid: process.getegid(),
  groups: process.getgroups(),
}));
`;
      const root = await cp(run, src);
      assert.equal(root.status, 0, root.stderr);
      assert.deepEqual(JSON.parse(root.stdout.trim()), {
        getuid: 0,
        geteuid: 0,
        getgid: 0,
        getegid: 0,
        groups: [0],
      });

      if (typeof kernel.users?.add !== 'function') return;
      await kernel.users.add({ name: 'cone' });
      const cone = await cp(run, src, { user: 'cone' });
      assert.equal(cone.status, 0, cone.stderr);
      const j = JSON.parse(cone.stdout.trim());
      assert.equal(j.getuid, 1000);
      assert.equal(j.geteuid, 1000);
      assert.equal(j.getgid, 1000);
      assert.equal(j.getegid, 1000);
      assert.ok(j.groups.includes(1000));
    } finally {
      close();
    }
  });

  it('signal death → close(null, SIGKILL); exec timeout kills (cp/signal.js)', async () => {
    const { run, close } = await withJsh();
    try {
      const r = await cp(
        run,
        `
const { spawn, execFile } = require('child_process');
const c = spawn('node', ['-e', 'setTimeout(()=>{}, 1e9)'], { stdio: 'ignore' });
c.on('spawn', () => setTimeout(() => console.log('kill ->', c.kill('SIGTERM')), 50));
c.on('exit', (code, sig) => {
  console.log('sleep exit', code, sig, 'killed', c.killed, 'signalCode', c.signalCode);
  const d = spawn('node', ['-e', "process.kill(process.pid, 'SIGKILL')"], { stdio: 'ignore' });
  d.on('close', (code2, sig2) => {
    console.log('self SIGKILL', code2, sig2);
    execFile('node', ['-e', 'setTimeout(()=>{}, 5000)'], { timeout: 200 }, (err) => {
      console.log('exec timeout', err && err.killed, err && err.signal, err && err.code);
    });
  });
});
`
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /sleep exit null SIGTERM killed true/);
      assert.match(r.stdout, /self SIGKILL null SIGKILL/);
      assert.match(r.stdout, /exec timeout true SIGTERM null/);
    } finally {
      close();
    }
  });

  it('ENOENT carries path and syscall spawn <cmd> (cp/enoent.js)', async () => {
    const { run, close } = await withJsh();
    try {
      const r = await cp(
        run,
        `
const { spawn, execFile } = require('child_process');
const c = spawn('definitely-not-a-cmd-xyz', ['a']);
c.on('error', (e) => {
  console.log('error', e.code, e.errno, e.syscall, e.path, JSON.stringify(e.spawnargs));
  execFile('definitely-not-a-cmd-xyz', (err) => {
    console.log('execFile ENOENT', err.code, err.errno, err.syscall, err.path);
  });
});
c.on('close', (code) => console.log('close after error', code));
`
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(
        r.stdout,
        /error ENOENT -2 spawn definitely-not-a-cmd-xyz definitely-not-a-cmd-xyz \["a"\]/
      );
      assert.match(
        r.stdout,
        /execFile ENOENT ENOENT -2 spawn definitely-not-a-cmd-xyz definitely-not-a-cmd-xyz/
      );
      assert.match(r.stdout, /close after error -2/);
    } finally {
      close();
    }
  });

  it('maxBuffer error message matches Node (cp/big.js)', async () => {
    const { run, close } = await withJsh();
    try {
      const r = await cp(
        run,
        `
const { execFile } = require('child_process');
execFile('node', ['-e', 'process.stdout.write(Buffer.alloc(2000000))'], (err, so) => {
  console.log('execFile 2 MB', err && err.code, err && err.message.split('\\n')[0], so && so.length);
});
`
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /stdout maxBuffer length exceeded/);
      assert.match(r.stdout, /ERR_CHILD_PROCESS_STDIO_MAXBUFFER/);
    } finally {
      close();
    }
  });
});
