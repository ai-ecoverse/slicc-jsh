import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { launch } from '../browser/chrome.mjs';
import { booted, installJsh, packJsh } from '../browser/kernel.mjs';

const kernel = JSON.parse(readFileSync(new URL('../../node_modules/@ai-ecoverse/slicc-kernel/package.json', import.meta.url), 'utf8')).version;
const atLeast = (min) => {
  const a = kernel.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};
const skip = !atLeast('1.146.5') && `slicc-kernel ${kernel} drops write-back past the quota silently (ai-ecoverse/slicc-kernel#1430)`;
const pack = mkdtempSync(join(tmpdir(), 'jsh-quota-pack-'));
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

const MIB = 1024 * 1024;
const script = [
  "const fs = require('fs');",
  `const MIB = ${MIB};`,
  'const size = 48 * MIB;',
  'const chunk = Buffer.alloc(MIB, 0x5a);',
  'const err = (e) => `${e.code} ${e.syscall}`;',
  'const kept = (name, asked) => { const b = fs.readFileSync(name); const ok = b.every((x) => x === 0x5a); return `${b.length === asked ? "all" : "short"} ${ok ? "kept" : "zeros"}`; };',
  'const verdict = (label, steps, name, asked) => {',
  '  const failed = steps.filter((x) => x !== "ok");',
  '  console.log(label, failed.length ? failed.join(" ") : "no error", kept(name, asked));',
  '  fs.rmSync(name, { force: true });',
  '};',
  '(async () => {',
  "  const fd = fs.openSync('sync.bin', 'w');",
  '  let at = 0; let wrote = "ok";',
  '  try { while (at < size) at += fs.writeSync(fd, chunk, 0, MIB, at); } catch (e) { wrote = err(e); }',
  '  let closed = "ok";',
  '  try { fs.closeSync(fd); } catch (e) { closed = err(e); }',
  "  verdict('writeSync', [wrote, closed], 'sync.bin', at);",
  "  const fh = await fs.promises.open('handle.bin', 'w');",
  '  let hat = 0; let hw = "ok";',
  '  try { while (hat < size) hat += (await fh.write(chunk, 0, MIB, hat)).bytesWritten; } catch (e) { hw = err(e); }',
  "  const hc = await fh.close().then(() => 'ok', err);",
  "  verdict('FileHandle', [hw, hc], 'handle.bin', hat);",
  '})();',
].join('\n');

test('a write past the quota is ENOSPC, never data that reads back as zeros', { skip }, async (t) => {
  const k = await booted(chrome, t, { cdp: false });
  await installJsh(k, chrome, tgz);
  await k.write('/home/t/quota.js', script);
  const { usage } = await k.page.evaluate(() => navigator.storage.estimate());
  await k.page.send('Storage.overrideQuotaForOrigin', { origin: new URL(chrome.url).origin, quotaSize: usage + 24 * MIB });
  const r = await k.run(['node', '--no-warnings', 'quota.js'], { cwd: '/home/t' });
  assert.equal(r.stderr, '');
  assert.equal(r.status, 0);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 2, r.stdout);
  for (const [line, label] of lines.map((l, i) => [l, ['writeSync', 'FileHandle'][i]])) {
    assert.match(line, new RegExp(`^${label} ENOSPC (write|close)( ENOSPC close)? (all|short) kept$`));
  }
  assert.deepEqual(k.page.errors, []);
});
