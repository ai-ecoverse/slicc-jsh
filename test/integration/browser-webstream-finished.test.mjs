/**
 * Web streams' ends in the harness Chromium, the kernel seven runs (#1270):
 * a browser's ReadableStream and WritableStream lack the end hooks Node's
 * have, so stream.finished() on one threw. undici's fetch calls it on every
 * response body (fetchFinale), and the throw ended the fetch, so a body that
 * arrived after its headers never ended and the program exited 13 on an
 * unsettled top-level await, as `cf auth login` did in its poll loop.
 *
 * The golden webstream-finished-node22 runs here and must print host Node
 * 22's output. Then undici, bundled into one ES module as cf's dist carries
 * it, fetches bodies that come after their headers from a server on the
 * kernel's loopback, and must get every one.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { launch } from '../browser/chrome.mjs';
import { booted, installJsh, packJsh } from '../browser/kernel.mjs';

const require = createRequire(import.meta.url);
const golden = join(dirname(fileURLToPath(import.meta.url)), '../golden/fixtures/webstream-finished-node22');
const pack = mkdtempSync(join(tmpdir(), 'jsh-webstream-pack-'));
let chrome;
let tgz;
let undici;

before(async () => {
  tgz = packJsh(pack);
  chrome = await launch({ pack: `${pack}/` });
  const bundled = await build({
    stdin: { contents: "export { fetch } from 'undici';", resolveDir: dirname(require.resolve('undici/package.json')) },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    logLevel: 'silent',
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  });
  undici = bundled.outputFiles[0].text;
}, { timeout: 900_000 });

after(async () => {
  await chrome?.close();
  rmSync(pack, { recursive: true, force: true });
});

test('web streams end as Node 22 says, and a bundled undici gets bodies that come late', { timeout: 900_000 }, async (t) => {
  const k = await booted(chrome, t, { cdp: false });
  await installJsh(k, chrome, tgz);
  for (const name of ['package.json', 'script.mjs']) await k.write(`/home/t/${name}`, readFileSync(join(golden, name), 'utf8'));
  const r = await k.run(['node', 'script.mjs'], { cwd: '/home/t' });
  assert.deepEqual(r, {
    status: Number(readFileSync(join(golden, 'status.txt'), 'utf8')),
    stdout: readFileSync(join(golden, 'stdout.bin'), 'utf8'),
    stderr: readFileSync(join(golden, 'stderr.bin'), 'utf8'),
  });

  await k.write('/home/t/undici.mjs', undici);
  await k.write(
    '/home/t/late-bodies.mjs',
    `import { createServer } from 'node:http';
import { fetch } from './undici.mjs';
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.flushHeaders();
  setTimeout(() => res.end('late ' + req.url), 30);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
for (let i = 0; i < 5; i++) {
  const res = await fetch(base + '/' + i, i % 2 ? { signal: AbortSignal.timeout(30000) } : {});
  console.log(res.status, await res.text());
}
server.close();
console.log('DONE');
`
  );
  // On a body that never ends the server keeps the program alive: timeout's 124.
  const late = await k.run(['timeout', '60', 'node', 'late-bodies.mjs'], { cwd: '/home/t' });
  assert.deepEqual(late, {
    status: 0,
    stdout: '200 late /0\n200 late /1\n200 late /2\n200 late /3\n200 late /4\nDONE\n',
    stderr: '',
  });
  assert.deepEqual(k.page.errors, []);
});
