// The smaller Node 22 gaps (phase 2, fix 13), all against host Node.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
const cwd = process.cwd();
let work;
const show = (label, f) => {
  try {
    console.log(label, util.inspect(f(), { depth: 4 }));
  } catch (e) {
    const fields = { code: e.code, errno: e.errno, syscall: e.syscall, path: e.path, dest: e.dest };
    for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
    const clean = (t) => t.split(work).join('WORK').split(cwd).join('CWD');
    console.log(label, 'THROWS', e.name, clean(e.message), clean(JSON.stringify(fields)));
  }
};

// process.chdir
work = fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'gaps-')));
fs.writeFileSync(path.join(work, 'file'), '');
show('chdir missing', () => process.chdir('no-such-dir'));
show('chdir file', () => process.chdir(path.join(work, 'file')));
show('chdir under file', () => process.chdir(path.join(work, 'file', 'x')));
show('chdir number', () => process.chdir(1));
show('chdir empty', () => process.chdir(''));
process.chdir(work);
console.log('chdir ok', process.cwd() === fs.realpathSync(work) || process.cwd() === work);
process.chdir(cwd);

// process.kill
show('kill other', () => process.kill(2147483646, 0));
show('kill bad signal', () => process.kill(process.pid, 'SIGNOPE'));
show('kill bad number', () => process.kill(process.pid, 99));
show('kill bad pid', () => process.kill('abc'));
show('kill INT name', () => process.kill(process.pid, 'INT'));
show('kill 0', () => process.kill(process.pid, 0));
show('kill SIGWINCH', () => process.kill(process.pid, 'SIGWINCH'));

// versions, release, ppid
console.log('versions', process.versions.node, process.versions.modules, process.versions.zlib, process.versions.uv, process.versions.v8);
console.log('release', process.release.name, typeof process.ppid, Number.isInteger(process.ppid));

// require(esm): __esModule facade
const esmDir = path.join(work, 'esm');
fs.mkdirSync(esmDir);
fs.writeFileSync(path.join(esmDir, 'withdefault.mjs'), 'export let a = 1; export default 2; export function bump() { a++; }');
fs.writeFileSync(path.join(esmDir, 'named.mjs'), 'export const b = 3;');
fs.writeFileSync(path.join(esmDir, 'own.mjs'), 'export const __esModule = false; export default 4;');
fs.writeFileSync(path.join(esmDir, 'cjsish.mjs'), 'const hi = 1; export { hi as "module.exports" };');
const m = require(path.join(esmDir, 'withdefault.mjs'));
console.log('esm facade', Object.keys(m), m.__esModule, m.default, m.a, Object.prototype.toString.call(m), Object.isExtensible(m));
m.bump();
console.log('esm live', m.a);
const n = require(path.join(esmDir, 'named.mjs'));
console.log('esm named', Object.keys(n), n.__esModule);
const o = require(path.join(esmDir, 'own.mjs'));
console.log('esm own', Object.keys(o), o.__esModule);
console.log('esm module.exports', require(path.join(esmDir, 'cjsish.mjs')));
fs.writeFileSync(path.join(esmDir, 'tla.mjs'), 'await 1; export default 1;');
show('esm tla', () => require(path.join(esmDir, 'tla.mjs')));

// console
console.log('%s is %d and %o', 'x', 42, { y: [1] });
console.log('100%', 5, '%s!');
console.assert(false, 'msg %d', 3);
console.assert(false, { x: 1 });
console.assert(false);
console.dir({ a: 1, [util.inspect.custom]: () => 'custom!' });
console.log({ [util.inspect.custom]: () => 'custom!' });

// crypto digests
console.log('sm3', crypto.createHash('sm3').update('abc').digest('hex'));
console.log('RSA-SM3', crypto.createHash('RSA-SM3').update('').digest('base64'));
console.log('hmac sm3', crypto.createHmac('sm3', 'key').update('abc').digest('hex'));
console.log('hash sm3', crypto.hash('sm3', 'abc'));
console.log('hkdf sm3', Buffer.from(crypto.hkdfSync('sm3', 'a', 'b', 'c', 8)).toString('hex'));
console.log('pbkdf2 sm3', crypto.pbkdf2Sync('a', 'b', 2, 8, 'sm3').toString('hex'));
console.log('getHashes sm3', crypto.getHashes().filter((h) => /sm3/i.test(h)));
for (const h of ['md4', 'RSA-MD4', 'whirlpool', 'mdc2', 'md2', 'nope']) {
  try {
    crypto.createHash(h);
  } catch (e) {
    console.log('createHash', h, e.message, e.code, Object.keys(e), e.opensslErrorStack);
  }
}
show('hmac md4', () => crypto.createHmac('md4', 'k'));
show('hash md4', () => crypto.hash('md4', 'x'));
show('pbkdf2Sync md4', () => crypto.pbkdf2Sync('a', 'b', 1, 8, 'md4'));
show('hkdfSync md4', () => crypto.hkdfSync('md4', 'a', 'b', 'c', 8));

// callback forms with no callback
const zlib = require('zlib');
show('brotliCompress no cb', () => zlib.brotliCompress('x'));
show('brotliCompress bad chunk', () => zlib.brotliCompress(5, () => {}));
show('zstdDecompress no cb', () => zlib.zstdDecompress('x', {}));
show('generateKeyPair no cb', () => crypto.generateKeyPair('rsa', { modulusLength: 512 }));
show('generatePrime no cb', () => crypto.generatePrime(8));
show('checkPrime no cb', () => crypto.checkPrime(7n));

// a signal sent to itself, with a handler (after the async job reports)
crypto.pbkdf2('a', 'b', 1, 8, 'md4', (e) => {
  console.log('pbkdf2 md4 async', e.message, e.code);
  process.on('SIGTERM', (name, num) => {
    console.log('handler', name, num);
    fs.rmSync(work, { recursive: true, force: true });
  });
  console.log('kill self', process.kill(process.pid, 'SIGTERM'));
  console.log('after kill');
  setTimeout(() => console.log('timer after the handler'), 20);
});
