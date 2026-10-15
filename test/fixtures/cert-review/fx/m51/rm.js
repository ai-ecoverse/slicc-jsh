const fs = require('fs'), path = require('path');
const [mode, D, X] = process.argv.slice(2);
const n = (s) => typeof s === 'string' ? s.split(D).join('<D>') : s;
const er = (e) => e ? `${e.name}|${e.code}|${e.errno}|${e.syscall}|${n(e.path)}|${n(e.message)}` : 'ok';
const t = (l, f) => { try { const r = f(); console.log(l, 'ok', r === undefined ? '' : JSON.stringify(r)); } catch (e) { console.log(l, er(e)); } };
const cb = (l, f) => new Promise((r) => f((e) => { console.log(l, er(e)); r(); }));
const pr = async (l, f) => { try { await f(); console.log(l, 'ok'); } catch (e) { console.log(l, er(e)); } };
const ex = (p) => fs.existsSync(p);
const tree = (root) => { fs.mkdirSync(path.join(root, 'a/b/c'), { recursive: true }); for (const f of ['x', 'a/y', 'a/b/z', 'a/b/c/w']) fs.writeFileSync(path.join(root, f), f); fs.symlinkSync('a/y', path.join(root, 'ln')); };
const ls = (p) => { const o = []; const w = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const q = path.join(d, e.name); o.push(n(q)); if (e.isDirectory() && !e.isSymbolicLink()) { try { w(q); } catch (er2) { o.push(`${n(q)}:${er2.code}`); } } } }; try { w(p); } catch (e) { return e.code; } return o.join(' '); };
(async () => {
  if (mode === 'local') {
    fs.rmSync(path.join(D, 'w'), { recursive: true, force: true }); fs.mkdirSync(path.join(D, 'w'));
    const W = path.join(D, 'w');
    tree(path.join(W, 't1')); t('rmSync tree', () => fs.rmSync(path.join(W, 't1'), { recursive: true })); console.log(' gone', !ex(path.join(W, 't1')));
    tree(path.join(W, 't2')); await cb('rm cb tree', (c) => fs.rm(path.join(W, 't2'), { recursive: true }, c)); console.log(' gone', !ex(path.join(W, 't2')));
    tree(path.join(W, 't3')); await pr('promises.rm tree', () => fs.promises.rm(path.join(W, 't3'), { recursive: true, maxRetries: 2 })); console.log(' gone', !ex(path.join(W, 't3')));
    t('rmSync missing recursive', () => fs.rmSync(path.join(W, 'nope'), { recursive: true }));
    t('rmSync missing recursive force', () => fs.rmSync(path.join(W, 'nope'), { recursive: true, force: true }));
    await cb('rm cb missing', (c) => fs.rm(path.join(W, 'nope'), { recursive: true }, c));
    await pr('promises.rm missing', () => fs.promises.rm(path.join(W, 'nope'), { recursive: true }));
    await pr('promises.rm missing force', () => fs.promises.rm(path.join(W, 'nope'), { recursive: true, force: true }));
    tree(path.join(W, 't4')); t('rmSync dir no recursive', () => fs.rmSync(path.join(W, 't4')));
    await cb('rm cb dir no recursive', (c) => fs.rm(path.join(W, 't4'), c));
    await pr('promises.rm dir no recursive', () => fs.promises.rm(path.join(W, 't4')));
    console.log(' t4 intact', ls(path.join(W, 't4')));
    t('rmSync file recursive', () => fs.rmSync(path.join(W, 't4/x'), { recursive: true })); console.log(' x gone', !ex(path.join(W, 't4/x')));
    t('rmSync through file', () => fs.rmSync(path.join(W, 't4/a/y/q'), { recursive: true }));
    fs.mkdirSync(path.join(W, 'keep')); fs.writeFileSync(path.join(W, 'keep/precious'), 'p');
    tree(path.join(W, 't5')); fs.symlinkSync(path.join(W, 'keep'), path.join(W, 't5/a/out'));
    t('rmSync tree with link outside', () => fs.rmSync(path.join(W, 't5'), { recursive: true })); console.log(' t5 gone', !ex(path.join(W, 't5')), 'keep intact', ls(path.join(W, 'keep')));
    fs.symlinkSync(path.join(W, 'keep'), path.join(W, 'dirlink'));
    t('rmSync symlink to dir recursive', () => fs.rmSync(path.join(W, 'dirlink'), { recursive: true })); console.log(' link gone', !ex(path.join(W, 'dirlink')) && !fs.readdirSync(W).includes('dirlink'), 'keep intact', ls(path.join(W, 'keep')));
    tree(path.join(W, 't6')); fs.chmodSync(path.join(W, 't6/a/b'), 0o555);
    t('rmSync tree with 555 subdir', () => fs.rmSync(path.join(W, 't6'), { recursive: true })); console.log(' left', ls(path.join(W, 't6')));
    await pr('promises.rm tree with 555 subdir', () => fs.promises.rm(path.join(W, 't6'), { recursive: true })); console.log(' left', ls(path.join(W, 't6')));
    fs.chmodSync(path.join(W, 't6/a/b'), 0o755); t('rmSync t6 after fix', () => fs.rmSync(path.join(W, 't6'), { recursive: true })); console.log(' gone', !ex(path.join(W, 't6')));
    t('rmSync bad opts', () => fs.rmSync(path.join(W, 'keep'), { recursive: 'yes' }));
    t('rmSync bad maxRetries', () => fs.rmSync(path.join(W, 'keep'), { recursive: true, maxRetries: -1 }));
    t('rmSync empty dir recursive', () => { fs.mkdirSync(path.join(W, 'e')); fs.rmSync(path.join(W, 'e'), { recursive: true }); return ex(path.join(W, 'e')); });
    const big = path.join(W, 'big'); for (let i = 0; i < 30; i++) { fs.mkdirSync(path.join(big, `d${i}`, 's'), { recursive: true }); for (let j = 0; j < 10; j++) fs.writeFileSync(path.join(big, `d${i}`, 's', `f${j}`), 'x'); }
    t('rmSync 300 files', () => fs.rmSync(big, { recursive: true })); console.log(' gone', !ex(big));
  }
  if (mode === 'other') {
    console.log('before', ls(X));
    t('rmSync other tree', () => fs.rmSync(X, { recursive: true }));
    console.log('after', ls(X));
    await pr('promises.rm other tree', () => fs.promises.rm(X, { recursive: true }));
    t('rmSync other tree force', () => fs.rmSync(X, { recursive: true, force: true }));
    console.log('after', ls(X));
  }
})();
