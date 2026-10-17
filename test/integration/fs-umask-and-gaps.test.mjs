/**
 * What the goldens can't pin against host Node:
 * - process.umask() starts as the kernel's umask (a user's 077), so a file
 *   jsh creates is never more open than the kernel would make it;
 * - require('wasi') is ERR_NOT_SUPPORTED (Node 22 has the module);
 * - BroadcastChannel stays out: the kernel locks the global (undefined, not
 *   configurable), as a guard against reaching other contexts of the origin.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { kernelAtLeast, kernelVersion, withJsh } from './helpers.mjs';

const needs = kernelAtLeast('1.86.0') ? {} : { skip: `slicc-kernel ${kernelVersion} has no ctx.fs.chmod (1.86.0)` };
const has192 = kernelAtLeast('1.92.0') ? {} : { skip: `slicc-kernel ${kernelVersion}: no ctx.umask / writable BroadcastChannel slot (1.92.0)` };
const old192 = kernelAtLeast('1.92.0') ? { skip: `slicc-kernel ${kernelVersion} leaves the BroadcastChannel slot open` } : {};

describe('process.umask and new files under a user’s umask (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    await jsh.kernel.users.add({ name: 'strict', umask: 0o077 });
  });
  after(() => jsh?.close());

  it('umask() is the kernel’s 077; files and directories keep to it, an explicit mode too', needs, async () => {
    await jsh.kernel.writeFile(
      '/tmp/um.js',
      [
        "const fs = require('fs');",
        "const perm = (p) => (fs.statSync(p).mode & 0o7777).toString(8);",
        "console.log('umask', process.umask().toString(8));",
        "fs.writeFileSync('/tmp/u1', 'x'); fs.writeFileSync('/tmp/u2', 'x', { mode: 0o666 }); fs.mkdirSync('/tmp/ud');",
        "console.log(perm('/tmp/u1'), perm('/tmp/u2'), perm('/tmp/ud'));",
        "process.umask(0o022); fs.writeFileSync('/tmp/u3', 'x'); console.log('after umask(022)', perm('/tmp/u3'));",
      ].join('\n')
    );
    const r = await jsh.run(['node', '/tmp/um.js'], { user: 'strict', cwd: '/tmp' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'umask 77\n600 600 700\nafter umask(022) 644\n');
  });
});

describe('modules and globals jsh leaves out (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  it("require('wasi') and 'dgram' are builtins jsh doesn't support: ERR_NOT_SUPPORTED", async () => {
    const r = await jsh.run([
      'node',
      '-e',
      "const m = require('module'); for (const id of ['wasi', 'node:wasi', 'dgram', 'node:dgram']) { try { require(id); console.log(id, 'loaded'); } catch (e) { console.log(id, m.isBuiltin(id), e.code); } }",
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'wasi true ERR_NOT_SUPPORTED\nnode:wasi true ERR_NOT_SUPPORTED\ndgram true ERR_NOT_SUPPORTED\nnode:dgram true ERR_NOT_SUPPORTED\n');
  });

  it('fs has no lchmod, as Node on Linux; promises.lchmod is ERR_METHOD_NOT_IMPLEMENTED', async () => {
    const r = await jsh.run([
      'node',
      '-e',
      "const fs = require('fs'); console.log(typeof fs.lchmod, typeof fs.lchmodSync); fs.promises.lchmod('/', 0o755).catch((e) => console.log(e.code, e.message));",
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'undefined undefined\nERR_METHOD_NOT_IMPLEMENTED The lchmod() method is not implemented\n');
  });

  it('BroadcastChannel: before slicc-kernel 1.92.0 the kernel locks the slot (undefined)', old192, async () => {
    const r = await jsh.run([
      'node',
      '-e',
      "const d = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel'); console.log(typeof BroadcastChannel, d && d.configurable, d && d.writable, typeof require('worker_threads').BroadcastChannel)",
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'undefined false false function\n');
  });

  it('BroadcastChannel (1.92.0+) is jsh’s, never the platform’s: in-process only, not across programs', has192, async () => {
    await jsh.kernel.writeFile(
      '/os/bc-listen.js',
      [
        "const ch = new BroadcastChannel('shared-name');",
        "ch.onmessage = (e) => { console.log('LEAK', JSON.stringify(e.data)); };",
        "setTimeout(() => { console.log('listener heard nothing'); ch.close(); }, 1500);",
      ].join('\n')
    );
    await jsh.kernel.writeFile(
      '/os/bc-post.js',
      [
        "const native = /\\[native code\\]/.test(Function.prototype.toString.call(BroadcastChannel));",
        "console.log('native', native, 'worker_threads same', require('worker_threads').BroadcastChannel === BroadcastChannel);",
        "const a = new BroadcastChannel('shared-name'); const b = new BroadcastChannel('shared-name');",
        "b.onmessage = (e) => { console.log('in-process', e.data); };",
        "let n = 0; const t = setInterval(() => { a.postMessage('ping ' + n++); if (n === 5) { clearInterval(t); setTimeout(() => { a.close(); b.close(); }, 50); } }, 100);",
      ].join('\n')
    );
    const [listener, poster] = await Promise.all([jsh.run(['node', 'bc-listen.js']), jsh.run(['node', 'bc-post.js'])]);
    assert.equal(poster.status, 0, poster.stderr);
    assert.equal(poster.stdout, 'native false worker_threads same true\nin-process ping 0\nin-process ping 1\nin-process ping 2\nin-process ping 3\nin-process ping 4\n');
    assert.equal(listener.status, 0, listener.stderr);
    assert.equal(listener.stdout, 'listener heard nothing\n');
  });

  it('process.umask(mask) (1.92.0+) is the kernel’s: a child inherits it', has192, async () => {
    const r = await jsh.run([
      'node',
      '-e',
      "const cp = require('child_process'); console.log(process.umask(0o027).toString(8), process.umask().toString(8)); console.log(cp.spawnSync('node', ['-e', 'console.log(process.umask().toString(8))'], { encoding: 'utf8' }).stdout.trim()); require('fs').writeFileSync('/tmp/um27', 'x', { mode: 0o666 }); console.log((require('fs').statSync('/tmp/um27').mode & 0o777).toString(8));",
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '22 27\n27\n640\n');
  });
});
