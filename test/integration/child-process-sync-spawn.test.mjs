/**
 * child_process.spawn on slicc-kernel 1.87.0's ctx.sync.spawn
 * (ai-ecoverse/slicc-kernel#492): the child starts inside spawn(), so
 * child.pid is set when it returns and signals sent right away reach it.
 * An older kernel starts it a tick later (child.pid undefined at return).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { kernelAtLeast, kernelVersion, withJshAndSh } from './helpers.mjs';

const HAS_SYNC_SPAWN = kernelAtLeast('1.87.0');
const needs = HAS_SYNC_SPAWN ? {} : { skip: `slicc-kernel ${kernelVersion} has no ctx.sync.spawn (1.87.0)` };

const program = (lines) => `(async () => {\n${lines.join('\n')}\n})().catch((e) => { console.error(e); process.exit(1); });\n`;
const CLOSED = "const closed = (c) => new Promise((res) => c.on('close', (code, sig) => res(`${code} ${sig}`)));";

describe('child_process.spawn with ctx.sync.spawn (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJshAndSh();
  });
  after(() => jsh?.close());

  it('process.kill(child.pid) right after spawn() reaches the child; its ppid is ours', needs, async () => {
    await jsh.kernel.writeFile(
      '/os/pid-now.js',
      program([
        "const cp = require('child_process');",
        CLOSED,
        "const c = cp.spawn('node', ['-e', 'console.log(process.ppid); setTimeout(() => {}, 20000)']);",
        "console.log('pid', typeof c.pid);",
        "let out = ''; c.stdout.on('data', (d) => (out += d));",
        // Wait for the child to be running, then signal it by the pid we had at once.
        "const pid = c.pid; await new Promise((r) => c.stdout.once('data', r));",
        "process.kill(pid, 'SIGTERM');",
        "console.log('close', await closed(c), 'ppid', Number(out.trim()) === process.pid);",
        "const d = cp.spawn('node', ['-e', 'setTimeout(() => {}, 20000)']);",
        "process.kill(d.pid, 'SIGKILL');",
        "console.log('close', await closed(d));",
      ])
    );
    const r = await jsh.run(['node', 'pid-now.js']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'pid number\nclose null SIGTERM ppid true\nclose null SIGKILL\n');
  });

  it('detached: process.kill(-child.pid) right after spawn() signals its new group', needs, async () => {
    await jsh.kernel.writeFile(
      '/os/group-now.js',
      program([
        "const cp = require('child_process');",
        CLOSED,
        "const c = cp.spawn('sh', ['-c', 'node -e \"setTimeout(() => {}, 20000)\"; echo survived'], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });",
        "let out = ''; c.stdout.on('data', (d) => (out += d));",
        "process.kill(-c.pid, 'SIGKILL');",
        "console.log('close', await closed(c), JSON.stringify(out));",
      ])
    );
    const r = await jsh.run(['node', 'group-now.js']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'close null SIGKILL ""\n');
  });

  it('jsh fds and devices closed right after spawn() still reach the child', needs, async () => {
    await jsh.kernel.writeFile(
      '/os/fds-now.js',
      program([
        "const cp = require('child_process'); const fs = require('fs');",
        CLOSED,
        "fs.writeFileSync('in.txt', 'from a file\\n');",
        "const i = fs.openSync('in.txt', 'r'); const o = fs.openSync('out.txt', 'w'); const n = fs.openSync('/dev/null', 'w');",
        "const c = cp.spawn('sh', ['-c', 'read l; echo \"got $l\"; echo err >&2'], { stdio: [i, o, n] });",
        "fs.closeSync(i); fs.closeSync(o); fs.closeSync(n);",
        "console.log('pid', typeof c.pid, 'close', await closed(c), JSON.stringify(fs.readFileSync('out.txt', 'utf8')));",
      ])
    );
    const r = await jsh.run(['node', 'fds-now.js']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'pid number close 0 null "got from a file\\n"\n');
  });

  it('a missing command: no throw, pid undefined, then error and close -2', needs, async () => {
    await jsh.kernel.writeFile(
      '/os/enoent-now.js',
      program([
        "const cp = require('child_process');",
        "const c = cp.spawn('no-such-command-zz');",
        "const seen = [`pid ${c.pid}`];",
        "c.on('error', (e) => seen.push(`error ${e.code} ${e.errno}`));",
        "c.on('spawn', () => seen.push('spawn'));",
        "c.on('exit', () => seen.push('exit'));",
        "await new Promise((r) => c.on('close', (code) => { seen.push(`close ${code}`); r(); }));",
        "console.log(seen.join(' | '));",
      ])
    );
    const r = await jsh.run(['node', 'enoent-now.js']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'pid undefined | error ENOENT -2 | close -2\n');
  });
});

describe('older kernels: spawn starts the child a tick later', () => {
  let jsh;
  before(async () => {
    jsh = await withJshAndSh();
  });
  after(() => jsh?.close());
});
