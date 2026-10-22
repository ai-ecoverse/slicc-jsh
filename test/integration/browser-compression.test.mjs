/**
 * CompressionStream / DecompressionStream keep a kernel jsh program alive
 * while the platform (de)compresses (#353, PR #385), in the harness
 * Chromium, where the platform's streams are the browser's native ones:
 * the golden compression-stream-keeps-alive-node22's program (an 8 MiB
 * round trip and Node 22's class shape) runs to its end, as in the kernel's
 * Node worker, instead of exiting 13 with an unsettled top-level await.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launch } from '../browser/chrome.mjs';
import { booted, installJsh, packJsh } from '../browser/kernel.mjs';

const golden = join(dirname(fileURLToPath(import.meta.url)), '../golden/fixtures/compression-stream-keeps-alive-node22');
const pack = mkdtempSync(join(tmpdir(), 'jsh-compression-pack-'));
let chrome;
let tgz;

before(async () => {
  tgz = packJsh(pack);
  chrome = await launch({ pack: `${pack}/` });
}, { timeout: 900_000 });

after(async () => {
  await chrome?.close();
  rmSync(pack, { recursive: true, force: true });
});

test('a CompressionStream round trip keeps a kernel program alive in the browser', { timeout: 900_000 }, async (t) => {
  const k = await booted(chrome, t, { cdp: false });
  await installJsh(k, chrome, tgz);
  await k.write('/home/t/package.json', readFileSync(join(golden, 'package.json'), 'utf8'));
  await k.write('/home/t/script.mjs', readFileSync(join(golden, 'script.mjs'), 'utf8'));
  const r = await k.run(['timeout', '120', 'node', '/home/t/script.mjs']);
  assert.deepEqual(r, { status: 0, stdout: readFileSync(join(golden, 'stdout.bin'), 'utf8'), stderr: '' });
  assert.deepEqual(k.page.errors, []);
});
