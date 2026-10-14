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

  it("require('wasi'), 'inspector' and 'trace_events' are builtins jsh doesn't support: ERR_NOT_SUPPORTED", async () => {
    const r = await jsh.run([
      'node',
      '-e',
      "const m = require('module'); for (const id of ['wasi', 'node:wasi', 'inspector', 'trace_events']) { try { require(id); console.log(id, 'loaded'); } catch (e) { console.log(id, m.isBuiltin(id), e.code); } }",
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'wasi true ERR_NOT_SUPPORTED\nnode:wasi true ERR_NOT_SUPPORTED\ninspector true ERR_NOT_SUPPORTED\ntrace_events true ERR_NOT_SUPPORTED\n');
  });

  it('BroadcastChannel is undefined and locked by the kernel', async () => {
    const r = await jsh.run([
      'node',
      '-e',
      "const d = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel'); console.log(typeof BroadcastChannel, d && d.configurable, d && d.writable)",
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'undefined false false\n');
  });
});
