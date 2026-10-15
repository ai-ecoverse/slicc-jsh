const fs = require('fs'), path = require('path'), cp = require('child_process');
const D = process.argv[2] || require('os').tmpdir(); const W = path.join(D, 'm54um'); fs.rmSync(W, { recursive: true, force: true }); fs.mkdirSync(W, { recursive: true });
const m = (p) => (fs.statSync(p).mode & 0o777).toString(8);
console.log('umask start', process.umask().toString(8));
const old = process.umask(0o027); console.log('set 027, returned', old.toString(8), 'now', process.umask().toString(8));
fs.mkdirSync(path.join(W, 'd')); fs.writeFileSync(path.join(W, 'f'), 'x'); console.log('new dir/file under 027', m(path.join(W, 'd')), m(path.join(W, 'f')));
console.log('child umask', cp.execFileSync('sh', ['-c', 'umask'], { encoding: 'utf8' }).trim(), cp.execFileSync(process.execPath, ['-p', 'process.umask().toString(8)'], { encoding: 'utf8' }).trim());
cp.execFileSync('sh', ['-c', `touch ${W}/kid; mkdir ${W}/kidd`]); console.log('child-made', m(path.join(W, 'kid')), m(path.join(W, 'kidd')));
process.umask(0o022); fs.writeFileSync(path.join(W, 'g'), 'x', { mode: 0o666 }); console.log('back 022 file', m(path.join(W, 'g')));
try { process.umask('abc'); } catch (e) { console.log('umask abc', e.code); }
console.log('umask octal string', process.umask('0077').toString(8), process.umask().toString(8)); process.umask(0o022);
