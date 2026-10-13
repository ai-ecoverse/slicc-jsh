// /dev as Node sees it (slicc-kernel 1.69+ shows it to JS programs): /dev/null,
// bounded reads of /dev/zero and /dev/urandom, a link to a device, a device's
// stat. (/dev/stdout & co. are in test/integration/fs-dev.test.mjs: on Linux,
// the golden harness's host Node has sockets, not pipes, as its stdio.)
const fs = require('fs');
const t = (l, f) => { try { const v = f(); console.log(l, JSON.stringify(v)); } catch (e) { console.log(l, 'THROWS', e.code, e.message); } };
t('write null', () => fs.writeFileSync('/dev/null', 'x'));
t('read null', () => fs.readFileSync('/dev/null', 'utf8'));
t('zero', () => { const fd = fs.openSync('/dev/zero', 'r'); const b = Buffer.alloc(4, 7); const n = fs.readSync(fd, b); fs.closeSync(fd); return [n, [...b]]; });
t('urandom', () => { const fd = fs.openSync('/dev/urandom', 'r'); const b = Buffer.alloc(16); const n = fs.readSync(fd, b); fs.closeSync(fd); return [n, b.some((x) => x !== 0)]; });
t('link to a device', () => { const l = require('os').tmpdir() + '/jsh-dev-link-' + process.pid; try { fs.unlinkSync(l); } catch {} fs.symlinkSync('/dev/zero', l); const fd = fs.openSync(l, 'r'); const b = Buffer.alloc(3, 1); const n = fs.readSync(fd, b); fs.closeSync(fd); fs.unlinkSync(l); return [n, [...b]]; });
t('stat null', () => { const s = fs.statSync('/dev/null'); return [s.isCharacterDevice(), s.isFile()]; });
t('exists', () => ['/dev/null', '/dev/zero', '/dev/stdout', '/dev/nope'].map((p) => fs.existsSync(p)));
t('nope', () => fs.readFileSync('/dev/nope'));
