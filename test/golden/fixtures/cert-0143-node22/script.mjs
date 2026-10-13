// cert 0.14.3 findings, against host Node: fs path arguments as file: URLs,
// the constants builtin, an imported binding's column in a frame.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import { boom, k } from './lib/mod.mjs';
const require = createRequire(import.meta.url);
const here = (p) => new URL(p, import.meta.url);
const t = async (l, f) => {
  try {
    console.log(l, JSON.stringify(await f()));
  } catch (e) {
    console.log(l, 'THROWS', e.name, e.code);
  }
};
const dir = fs.mkdtempSync(new URL('./tmp-', import.meta.url).pathname);
const u = (p) => new URL(`file://${dir}/${p}`);
await t('write/read/stat a URL', () => {
  fs.writeFileSync(u('a.txt'), 'x');
  fs.appendFileSync(u('a.txt'), 'y');
  return [fs.readFileSync(u('a.txt'), 'utf8'), fs.existsSync(u('a.txt')), fs.statSync(u('a.txt')).size, fs.lstatSync(u('a.txt')).isFile()];
});
await t('mkdir/readdir/rename/copy/unlink URLs', () => {
  fs.mkdirSync(u('d/e'), { recursive: true });
  fs.copyFileSync(u('a.txt'), u('d/b.txt'));
  fs.renameSync(u('d/b.txt'), u('d/c.txt'));
  const list = fs.readdirSync(u('d')).sort();
  fs.unlinkSync(u('d/c.txt'));
  return [list, fs.readdirSync(u('d'))];
});
await t('promises and callbacks with URLs', async () => {
  await fsp.writeFile(u('p.txt'), 'p');
  const viaCb = await new Promise((r, j) => fs.readFile(u('p.txt'), 'utf8', (e, d) => (e ? j(e) : r(d))));
  return [await fsp.readFile(u('p.txt'), 'utf8'), viaCb, (await fsp.stat(u('p.txt'))).size];
});
await t('streams with URLs', () => new Promise((r) => fs.createWriteStream(u('s.txt')).end('s', () => fs.createReadStream(u('s.txt'), 'utf8').on('data', r))));
await t('a URL of another scheme', () => fs.readFileSync(new URL('http://example.com/x')));
await t('a file URL with a host', () => fs.readFileSync(new URL('file://host/x')));
await t('a file URL with an encoded slash', () => fs.readFileSync(new URL('file:///a%2Fb')));
await t('promises reject a bad URL', () => fsp.readFile(new URL('http://example.com/x')).then(() => 'resolved', (e) => ['rejected', e.code]));
await t('exists / existsSync of a bad URL', () => new Promise((r) => fs.exists(new URL('http://example.com/x'), (v) => r([v, fs.existsSync(new URL('file://host/x')), fs.existsSync(u('a.txt'))]))));
await t('realpath.native with URLs', () => new Promise((r, j) => fs.realpath.native(u('a.txt'), (e, p) => (e ? j(e) : r([p.endsWith('/a.txt'), fs.realpathSync.native(u('a.txt')).endsWith('/a.txt')])))));
await t('a callback API throws for a bad URL', () => fs.readFile(new URL('http://example.com/x'), () => {}));
fs.rmSync(u(''), { recursive: true, force: true });
const c = require('constants');
await t('constants', () => [Object.isFrozen(c), c.O_RDONLY, c.O_WRONLY, c.SIGINT, c.SIGTERM, c.ENOENT, c.EACCES, c.S_IFDIR, c.S_IFREG, c.F_OK, c.R_OK, c.RSA_PKCS1_PADDING, c.PRIORITY_LOW, c.COPYFILE_EXCL, require('module').builtinModules.includes('constants')]);
await t('import of node:constants', async () => (await import('node:constants')).default === c);
const e = boom(); const f = new Error('here');
const at = (err, i) => err.stack.split('\n')[i].replace(import.meta.url, 'URL');
console.log('columns', at(e, 2), '|', at(f, 1), '|', k, at(boom(), 2));
