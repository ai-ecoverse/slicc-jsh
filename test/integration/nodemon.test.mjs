/**
 * The real nodemon 3 forks the app with an IPC channel (child_process.fork,
 * slicc-kernel 1.125.11's ctx.socketpair) and restarts it when a watched file
 * changes. Its restart kills the old app through pstree.remy, which runs
 * `ps` under `sh`, so the kernel gets wasm-bash and wasm-coreutils.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devPackageFiles, devPackageTree, withJshAndSh } from './helpers.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const version = (name) => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

describe('nodemon (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJshAndSh();
    for (const [path, data] of devPackageFiles('@ai-ecoverse/wasm-coreutils')) await jsh.kernel.writeFile(path, data);
    for (const [path, data] of devPackageTree('nodemon')) await jsh.kernel.writeFile(path, data);
  });
  after(() => jsh?.close());

  // nodemon handles SIGTERM itself: it stops the app and quits with 143.
  it('runs the app with a channel, restarts it when the file changes, and quits with 143 on SIGTERM', async () => {
    assert.equal(version('nodemon'), '3.1.14');
    await jsh.kernel.writeFile('/os/nm/app.js', "console.log('app v1', typeof process.send);\n");
    // The driver edits app.js once v1 has run, and stops nodemon once v2 has.
    await jsh.kernel.writeFile(
      '/os/nm/driver.js',
      `const { spawn } = require('child_process');
const fs = require('fs');
const n = spawn(process.execPath, ['/node_modules/nodemon/bin/nodemon.js', '--watch', '.', '--ext', 'js', 'app.js'], {
  cwd: __dirname,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
let wrote = false;
let killed = false;
const step = (d) => {
  out += d;
  if (out.includes('app v1') && !wrote) {
    wrote = true;
    fs.writeFileSync(__dirname + '/app.js', "console.log('app v2', typeof process.send);\\n", { flag: 'r+' });
  }
  if (out.includes('app v2') && !killed) {
    killed = true;
    n.kill('SIGTERM');
  }
};
n.stdout.on('data', step);
n.stderr.on('data', step);
n.on('exit', (code, signal) => {
  console.log(out.replace(/\\x1b\\[[0-9;]*m/g, '').split('\\n').filter((l) => l.startsWith('app ') || l.includes('restarting')).join('\\n'));
  console.log('nodemon exit', code, signal);
});
`
    );
    const r = await jsh.run(['node', 'driver.js'], { cwd: '/os/nm' });
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'app v1 function\n[nodemon] restarting due to changes...\napp v2 function\nnodemon exit 143 null\n');
  });
});
