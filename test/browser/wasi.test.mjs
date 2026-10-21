/**
 * node:wasi in the harness Chromium, the kernel seven runs (#525): the
 * golden wasi-node22's program (Node's own lib/wasi.js over the kernel's
 * WASI host: a program's args, environment, preopen, file read, stderr and
 * exit code, a reactor, Node's option checks) gives host Node 22's output,
 * as in the kernel's Node worker.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launch } from './chrome.mjs';
import { booted, installJsh, packJsh } from './kernel.mjs';

const golden = join(dirname(fileURLToPath(import.meta.url)), '../golden/fixtures/wasi-node22');
const pack = mkdtempSync(join(tmpdir(), 'jsh-wasi-pack-'));
let chrome;
let tgz;

before(async () => {
  tgz = packJsh(pack);
  chrome = await launch({ pack: `${pack}/` });
});

after(async () => {
  await chrome?.close();
  rmSync(pack, { recursive: true, force: true });
});

test('node:wasi runs a WASI program in the browser as host Node does', async (t) => {
  const k = await booted(chrome, t, { cdp: false });
  await installJsh(k, chrome, tgz);
  for (const name of ['package.json', 'script.js', 'sandbox/data.txt']) await k.write(`/home/t/${name}`, readFileSync(join(golden, name), 'utf8'));
  // The modules go as base64 (the write is text), made bytes in the kernel.
  for (const name of ['prog.wasm', 'reactor.wasm']) await k.write(`/home/t/${name}.b64`, readFileSync(join(golden, name)).toString('base64'));
  const decode = await k.run([
    'node',
    '-e',
    "const fs = require('fs'); for (const n of ['prog.wasm', 'reactor.wasm']) fs.writeFileSync('/home/t/' + n, Buffer.from(fs.readFileSync('/home/t/' + n + '.b64', 'utf8'), 'base64'));",
  ]);
  assert.equal(decode.status, 0, decode.stderr);
  const r = await k.run(['timeout', '120', 'node', '--no-warnings', 'script.js'], { cwd: '/home/t' });
  assert.deepEqual(r, {
    status: Number(readFileSync(join(golden, 'status.txt'), 'utf8')),
    stdout: readFileSync(join(golden, 'stdout.bin'), 'utf8'),
    stderr: readFileSync(join(golden, 'stderr.bin'), 'utf8'),
  });
  assert.deepEqual(k.page.errors, []);
});
