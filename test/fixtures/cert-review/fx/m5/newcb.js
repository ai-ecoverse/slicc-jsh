const fs = require('fs'); const { fresh, E, tree } = require('./h.cjs');
const d = fresh('w-cb'); fs.writeFileSync(`${d}/a`, 'abcdef'); fs.mkdirSync(`${d}/t/s`, { recursive: true }); fs.writeFileSync(`${d}/t/s/f`, 'f');
const steps = [
  (n) => fs.copyFile(`${d}/a`, `${d}/b`, (e) => n('copyFile', e, fs.readFileSync(`${d}/b`, 'utf8'))),
  (n) => fs.copyFile(`${d}/a`, `${d}/b`, fs.constants.COPYFILE_EXCL, (e) => n('copyFile EXCL', e)),
  (n) => fs.cp(`${d}/t`, `${d}/t2`, { recursive: true }, (e) => n('cp', e, tree(`${d}/t2`))),
  (n) => fs.cp(`${d}/t`, `${d}/t/s/in`, { recursive: true }, (e) => n('cp into self', e, tree(`${d}/t`))),
  (n) => fs.mkdtemp(`${d}/x-`, (e, p) => n('mkdtemp', e, p && p.length === `${d}/x-`.length + 6)),
  (n) => fs.truncate(`${d}/b`, 2, (e) => n('truncate', e, fs.readFileSync(`${d}/b`, 'utf8'))),
  (n) => fs.truncate(`${d}/zz`, 2, (e) => n('truncate missing', e)),
  (n) => fs.opendir(`${d}/t`, (e, dir) => { if (e) return n('opendir', e); dir.read((e2, ent) => { dir.close(() => n('opendir', e2, ent && ent.name + ' ' + ent.parentPath)); }); }),
  (n) => fs.rm(`${d}/t2`, (e) => n('rm dir no recursive', e, tree(`${d}/t2`))),
  (n) => fs.rm(`${d}/t2`, { recursive: true }, (e) => n('rm recursive', e, fs.existsSync(`${d}/t2`))),
  (n) => fs.rm(`${d}/zz`, { force: true }, (e) => n('rm missing force', e)),
  (n) => fs.rm(`${d}/zz`, (e) => n('rm missing', e)),
  (n) => fs.rmdir(`${d}/t`, (e) => n('rmdir non-empty', e, tree(`${d}/t`))),
  (n) => fs.rmdir(`${d}/t`, { recursive: true }, (e) => n('rmdir recursive', e, fs.existsSync(`${d}/t`))),
  (n) => fs.stat(`${d}/a`, (e, s) => n('stat instanceof', e, s instanceof fs.Stats)),
  (n) => fs.chmod(`${d}/zz`, 0o600, (e) => n('chmod missing', e)),
  (n) => fs.readdir(d, { withFileTypes: true }, (e, l) => n('readdir withFileTypes parentPath', e, l.map((x) => `${x.name}@${x.parentPath}`).sort().join(' '))),
  (n) => fs.readdir(d, { recursive: true }, (e, l) => n('readdir recursive cb', e, l.sort().join(','))),
];
let i = 0; const next = (label, e, v) => { if (label) console.log(label, '->', e ? 'ERR ' + E(e) : 'ok', v === undefined ? '' : JSON.stringify(v)); const s = steps[i++]; if (s) s(next); };
next();
