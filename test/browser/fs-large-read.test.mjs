import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installJsh, packJsh } from './kernel.mjs';

const pack = mkdtempSync(join(tmpdir(), 'jsh-large-read-pack-'));
let chrome;
let tgz;

before(async () => {
  tgz = packJsh(pack);
  chrome = await launch({ pack: `${pack}/`, persistent: true });
});

after(async () => {
  await chrome?.close();
  rmSync(pack, { recursive: true, force: true });
});

const script = [
  "const fs = require('fs');",
  'const show = (label) => (e) => console.log(label, e ? `${e.name} ${e.code} ${e.message}` : "read");',
  'const sync = (label, fn) => { try { const v = fn(); console.log(label, "read", v.length); } catch (e) { show(label)(e); } };',
  "const sparse = (name, size) => { const fd = fs.openSync(name, 'w'); fs.ftruncateSync(fd, size); fs.closeSync(fd); };",
  '(async () => {',
  "  sparse('long.txt', 0x1fffffe8 + 1);",
  "  sync('buffer', () => fs.readFileSync('long.txt'));",
  "  for (const enc of ['utf8', 'utf-8', 'UTF8', 'latin1']) sync(enc, () => fs.readFileSync('long.txt', enc));",
  "  const fd = fs.openSync('long.txt', 'r');",
  "  sync('fd utf8', () => fs.readFileSync(fd, 'utf8'));",
  '  fs.closeSync(fd);',
  "  await new Promise((r) => fs.readFile('long.txt', 'utf8', (e) => r(show('callback utf8')(e))));",
  "  fs.unlinkSync('long.txt');",
  "  sparse('over.bin', 2 ** 31);",
  "  sync('over buffer', () => fs.readFileSync('over.bin'));",
  "  sync('over utf8', () => fs.readFileSync('over.bin', 'utf8'));",
  "  await fs.promises.readFile('over.bin').then(() => show('over promises')(), show('over promises'));",
  "  fs.unlinkSync('over.bin');",
  '})();',
].join('\n');

test('large reads give Node 22 errors in Chrome', async (t) => {
  const k = await booted(chrome, t, { cdp: false });
  await installJsh(k, chrome, tgz);
  await k.write('/home/t/large.js', script);
  const r = await k.run(['node', '--no-warnings', 'large.js'], { cwd: '/home/t' });
  const long = 'Error ERR_STRING_TOO_LONG Cannot create a string longer than 0x1fffffe8 characters';
  const large = 'RangeError ERR_FS_FILE_TOO_LARGE File size (2147483648) is greater than 2 GiB';
  assert.deepEqual(r, {
    status: 0,
    stdout: [
      'buffer read 536870889',
      `utf8 ${long}`,
      `utf-8 ${long}`,
      `UTF8 ${long}`,
      `latin1 ${long}`,
      `fd utf8 ${long}`,
      `callback utf8 ${long}`,
      `over buffer ${large}`,
      `over utf8 ${long}`,
      `over promises ${large}`,
      '',
    ].join('\n'),
    stderr: '',
  });
  assert.deepEqual(k.page.errors, []);
});
