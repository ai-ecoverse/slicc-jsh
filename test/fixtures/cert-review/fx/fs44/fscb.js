const fs = require('fs');
fs.writeFileSync('/tmp/fs44.txt', 'hello');
const out = [];
for (const [name, call] of [
  ['readFile(path)', () => fs.readFile('/tmp/fs44.txt')], ['writeFile(p,d)', () => fs.writeFile('/tmp/fs44b.txt', 'x')], ['stat(p)', () => fs.stat('/tmp/fs44.txt')],
  ['readdir(p)', () => fs.readdir('/tmp')], ['unlink(p)', () => fs.unlink('/tmp/nope44')], ['mkdir(p)', () => fs.mkdir('/tmp/d44')], ['open(p)', () => fs.open('/tmp/fs44.txt')],
  ['access(p)', () => fs.access('/tmp/fs44.txt')], ['readFile(p, "utf8")', () => fs.readFile('/tmp/fs44.txt', 'utf8')], ['rename(a,b)', () => fs.rename('/tmp/a44', '/tmp/b44')],
  ['readFile(p, cb=123)', () => fs.readFile('/tmp/fs44.txt', 123)], ['exists(p) (deprecated, no cb)', () => fs.exists('/tmp/fs44.txt')],
]) { try { call(); out.push(`${name}: no throw`); } catch (e) { out.push(`${name}: ${e.name} ${e.code}`); } }
console.log(out.join('\n'));
fs.readFile('/tmp/fs44.txt', 'utf8', (e, d) => { console.log('readFile cb', e, d);
  fs.stat('/tmp/fs44.txt', (e2, st) => { console.log('stat cb', e2, st.size);
    fs.writeFile('/tmp/fs44c.txt', 'cbw', (e3) => { console.log('writeFile cb', e3, fs.readFileSync('/tmp/fs44c.txt', 'utf8'));
      fs.readdir('/tmp', (e4, l) => { console.log('readdir cb', e4, l.includes('fs44c.txt'));
        fs.unlink('/tmp/nope44', (e5) => console.log('unlink cb err', e5 && e5.code)); }); }); }); });
