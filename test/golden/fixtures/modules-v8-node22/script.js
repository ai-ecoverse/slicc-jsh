// cert 0.12.1 findings, against host Node: node: specifiers that aren't
// builtins, require() not trying .cjs, the names cjs-module-lexer gives an
// imported CommonJS module, Node's missing-named-export messages, fs streams'
// fd, the v8 module.
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv8-'));
const w = (f, s) => fs.writeFileSync(path.join(dir, f), s);
const at = (f) => path.join(dir, f);
const clean = (m) => String(m).split(fs.realpathSync(dir)).join('DIR').split(dir).join('DIR');
const t = async (l, f) => {
  try {
    console.log(l, JSON.stringify(await f()));
  } catch (e) {
    console.log(l, 'THROWS', e.name, e.code, clean(e.message.split('\n')[0]));
  }
};
w('c.cjs', 'module.exports = "cjs";');
w('lit.cjs', 'const c = 1; module.exports = {c};');
w('lit2.cjs', 'module.exports = {c: 1, d: 2};');
w('ex.cjs', 'exports.a = 1; exports.b = function () {}; Object.defineProperty(exports, "c", { enumerable: true, get() { return 3; } });');
w('re.cjs', 'module.exports = require("./ex.cjs");');
w('babel.cjs', '"use strict"; Object.defineProperty(exports, "__esModule", { value: true }); exports.default = 42; exports.named = 1;');
w('fn.cjs', 'module.exports = function f() {}; module.exports.x = 1;');
w('live.cjs', 'exports.x = 1; exports.later = () => { exports.x = 2; };');
w('live.mjs', "import { x, later } from './live.cjs'; import d from './live.cjs'; later(); export const seen = [x, d.x];");
w('ca.cjs', 'exports.a = 1;\nmodule.exports = require("./cb.cjs");\n');
w('cb.cjs', 'exports.b = 2;\nmodule.exports = require("./ca.cjs");\n');
w('esm.mjs', 'export const a = 1;');
w('i1.mjs', "import { nope } from './esm.mjs';");
w('i2.mjs', "import { nope } from './ex.cjs';");
w('i3.mjs', "import { nope } from 'node:fs';");
(async () => {
  await t('require node:nope', () => require('node:nope'));
  await t('import node:nope', () => import('node:nope'));
  await t('import node:fs/nope', () => import('node:fs/nope'));
  await t('require ./c (no .cjs)', () => require(at('c')));
  for (const f of ['lit', 'lit2', 'ex', 're', 'babel', 'fn']) {
    await t(`import ${f}.cjs`, async () => { const ns = await import(at(`${f}.cjs`)); return [Object.keys(ns), typeof ns.default, ns.default && ns.default.default]; });
  }
  await t('named CJS exports are a snapshot, default is live', async () => (await import(at('live.mjs'))).seen);
  await t('CJS re-export cycle', async () => [Object.keys(await import(at('ca.cjs'))), Object.keys(await import(at('cb.cjs')))]);
  for (const f of ['i1', 'i2', 'i3']) await t(`missing export ${f}`, () => import(at(`${f}.mjs`)));
  await t('write stream fd', () => new Promise((r) => { const ws = fs.createWriteStream(at('w.txt')); const before = [ws.fd, ws.pending]; ws.on('open', (fd) => { const after = [typeof ws.fd, ws.fd === fd, ws.pending]; ws.end('x', () => r([before, after])); }); }));
  await t('read stream fd', () => new Promise((r) => { const rs = fs.createReadStream(at('w.txt')); const before = [rs.fd, rs.pending]; rs.on('open', (fd) => { r([before, typeof rs.fd, rs.fd === fd, rs.pending]); rs.destroy(); }); }));
  await t('streams after autoClose', () => new Promise((r) => { const out = []; const ws = fs.createWriteStream(at('w2.txt')); ws.on('finish', () => out.push(['ws finish', typeof ws.fd])); ws.on('close', () => { out.push(['ws close', ws.fd, ws.pending]); const rs = fs.createReadStream(at('w2.txt')); rs.on('end', () => out.push(['rs end', typeof rs.fd])); rs.on('close', () => { out.push(['rs close', rs.fd, rs.pending]); r(out); }); rs.resume(); }); ws.end('y'); }));
  await t('streams destroyed', () => new Promise((r) => { const ws = fs.createWriteStream(at('w3.txt')); ws.on('open', () => ws.destroy()); ws.on('close', () => { const rs = fs.createReadStream(at('w2.txt')); rs.on('open', () => rs.destroy()); rs.on('close', () => r([ws.fd, ws.pending, rs.fd, rs.pending])); }); }));
  const v8 = require('v8');
  await t('v8 keys', () => Object.keys(v8).sort());
  await t('v8 snapshot', () => [v8.startupSnapshot.isBuildingSnapshot(), Object.keys(v8.startupSnapshot)]);
  await t('v8 addSerializeCallback', () => v8.startupSnapshot.addSerializeCallback(() => {}));
  await t('v8 heap', () => [Object.keys(v8.getHeapStatistics()), Object.keys(v8.getHeapSpaceStatistics()[0]), Object.keys(v8.getHeapCodeStatistics()), typeof v8.cachedDataVersionTag()]);
  await t('v8 misc', () => [v8.isStringOneByteRepresentation('abc'), v8.isStringOneByteRepresentation('€'), v8.setFlagsFromString('--stack-size=900')]);
  await t('v8 setFlags bad', () => v8.setFlagsFromString(1));
  fs.rmSync(dir, { recursive: true, force: true });
})();
