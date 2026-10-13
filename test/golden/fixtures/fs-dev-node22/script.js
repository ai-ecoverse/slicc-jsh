// /dev as Node sees it (slicc-kernel 1.69+ shows it to JS programs): writes to
// /dev/null and the std streams by path, bounded reads of /dev/zero and
// /dev/urandom, /dev/fd/N, a device's stat.
const fs = require('fs');
const t = (l, f) => { try { const v = f(); console.log(l, JSON.stringify(v)); } catch (e) { console.log(l, 'THROWS', e.code, e.message); } };
t('write null', () => fs.writeFileSync('/dev/null', 'x'));
t('read null', () => fs.readFileSync('/dev/null', 'utf8'));
t('append stdout', () => fs.appendFileSync('/dev/stdout', 'to stdout\n'));
t('append stderr', () => fs.appendFileSync('/dev/stderr', 'to stderr\n'));
t('zero', () => { const fd = fs.openSync('/dev/zero', 'r'); const b = Buffer.alloc(4, 7); const n = fs.readSync(fd, b); fs.closeSync(fd); return [n, [...b]]; });
t('urandom', () => { const fd = fs.openSync('/dev/urandom', 'r'); const b = Buffer.alloc(16); const n = fs.readSync(fd, b); fs.closeSync(fd); return [n, b.some((x) => x !== 0)]; });
t('fd1', () => { const fd = fs.openSync('/dev/fd/1', 'w'); fs.writeSync(fd, 'via /dev/fd/1\n'); fs.closeSync(fd); return 'ok'; });
t('stat null', () => { const s = fs.statSync('/dev/null'); return [s.isCharacterDevice(), s.isFile()]; });
t('exists', () => ['/dev/null', '/dev/zero', '/dev/stdout', '/dev/nope'].map((p) => fs.existsSync(p)));
t('nope', () => fs.readFileSync('/dev/nope'));
const ws = fs.createWriteStream('/dev/stdout');
ws.write('stream to stdout\n');
ws.end(() => console.log('stream ended'));
