const fs = require('fs'), path = require('path'), os = require('os');
const tree = (root) => { fs.mkdirSync(path.join(root, 'a/b/c'), { recursive: true }); for (const f of ['x', 'a/y', 'a/b/z', 'a/b/c/w']) fs.writeFileSync(path.join(root, f), f); fs.symlinkSync('a/y', path.join(root, 'ln')); };
const ls = (p) => { const o = []; const w = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const q = path.join(d, e.name); o.push(path.relative(p, q)); if (e.isDirectory()) w(q); } }; w(p); return o.join(' '); };
const er = (e) => e ? `${e.code} ${e.syscall} ${path.relative(W, e.path)}` : 'ok';
const W = fs.mkdtempSync(path.join(process.argv[2] || os.tmpdir(), 'rm555-'));
(async () => {
  const t6 = path.join(W, 't6');
  const which = process.argv[3] || 'all';
  if (which !== 'promises') { tree(t6); fs.chmodSync(path.join(t6, 'a/b'), 0o555); try { fs.rmSync(t6, { recursive: true }); console.log('rmSync ok'); } catch (e) { console.log('rmSync', er(e)); } console.log(' left', ls(t6)); fs.chmodSync(path.join(t6, 'a/b'), 0o755); fs.rmSync(t6, { recursive: true }); }
  if (which !== 'sync') { tree(t6); fs.chmodSync(path.join(t6, 'a/b'), 0o555); await new Promise((r) => fs.rm(t6, { recursive: true }, (e) => { console.log('rm cb', er(e)); r(); })); console.log(' left', ls(t6)); fs.chmodSync(path.join(t6, 'a/b'), 0o755); fs.rmSync(t6, { recursive: true });
    tree(t6); fs.chmodSync(path.join(t6, 'a/b'), 0o555); try { await fs.promises.rm(t6, { recursive: true }); console.log('promises ok'); } catch (e) { console.log('promises.rm', er(e)); } console.log(' left', ls(t6)); fs.chmodSync(path.join(t6, 'a/b'), 0o755); }
  fs.rmSync(W, { recursive: true });
})();
