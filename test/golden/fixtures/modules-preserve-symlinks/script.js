// pnpm's isolated layout: node_modules/dep -> .pnpm/dep@1.0.0/node_modules/dep,
// and dep's own dependency `peer` next to it in the store.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mrp-')));
const rel = (p) => String(p).split(work).join('W');
const store = `${work}/node_modules/.pnpm/dep@1.0.0/node_modules`;
fs.mkdirSync(`${store}/dep`, { recursive: true });
fs.mkdirSync(`${store}/peer`, { recursive: true });
fs.writeFileSync(`${store}/dep/package.json`, JSON.stringify({ name: 'dep', version: '1.0.0', main: 'i.js', exports: { '.': { import: './i.mjs', default: './i.js' } } }));
fs.writeFileSync(`${store}/dep/i.js`, "exports.where = __filename; exports.peer = (() => { try { return require('peer').v; } catch (e) { return e.code; } })();");
fs.writeFileSync(`${store}/dep/i.mjs`, "import peer from 'peer'; export const where = import.meta.url; export const v = peer.v;");
fs.writeFileSync(`${store}/peer/package.json`, '{"name":"peer","main":"p.js"}');
fs.writeFileSync(`${store}/peer/p.js`, 'exports.v = "peer-ok";');
fs.symlinkSync('.pnpm/dep@1.0.0/node_modules/dep', `${work}/node_modules/dep`);
fs.writeFileSync(`${work}/esm.mjs`, "export { where, v } from 'dep'; export const resolved = import.meta.resolve('dep');");
const req = createRequire(`${work}/main.js`);
const m = req('dep');
console.log('require', rel(m.where), m.peer);
console.log('require.resolve', rel(req.resolve('dep')));
console.log('module.paths of dep', rel(Object.values(require.cache).find((x) => x.filename === m.where)?.paths?.[0]));
import(`${work}/esm.mjs`).then((e) => {
  console.log('import', rel(e.where), e.v);
  console.log('import.meta.resolve', rel(e.resolved));
  fs.rmSync(work, { recursive: true, force: true });
}, (e) => {
  // Node's message names the machine's temp path; the code is enough.
  console.log('import', e.code);
  fs.rmSync(work, { recursive: true, force: true });
});
