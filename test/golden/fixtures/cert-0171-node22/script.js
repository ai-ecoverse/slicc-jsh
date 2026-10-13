// cert A2 findings on 0.17.1, against host Node: the SyntaxError report for
// -p, an ES module -e, a BOM file, an invalid character, a module's strict
// words; HMAC and the KDFs over md5-sha1 and the XOFs.
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c171-'));
const clean = (s) =>
  String(s)
    .split(`file://${fs.realpathSync(dir)}`).join('file://DIR')
    .split(`file://${dir}`).join('file://DIR')
    .split(fs.realpathSync(dir)).join('DIR')
    .split(dir).join('DIR');
const report = (args) => {
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' });
  // Frames are Node's internals. Under an -e/-p caret Node 22.22 prints its
  // TypeScript parser's hint ("Expression expected", …), which jsh doesn't have.
  const lines = r.stderr.split('\n').filter((l) => !/^\s+at /.test(l));
  const out = lines.filter((l, i) => !(i > 0 && /^\s*\^*\s*$/.test(lines[i - 1]) && lines[i - 1] !== '' && l !== '' && lines[i + 1] === '' && !/Error/.test(l)));
  return [r.status, clean(out.join('\n'))];
};
const write = (f, s) => fs.writeFileSync(path.join(dir, f), s);
write('bom.js', '\uFEFFconst x = ;\n');
write('bom.mjs', '\uFEFFconst x = ;\n');
write('at.js', 'const a = @;\n');
write('str.js', "const s = 'open\n");
write('ll.mjs', 'let let = 1;\n');
const tokens = ['const x = \\u{110000};', 'const u = "\\x4";', 'const y = 1n2;', 'const z = 0x;', 'const w = #;', 'const r = /ab;', 'const t = `abc'];
tokens.forEach((src, i) => write(`tok${i}.js`, `${src}\n`));
for (const [l, args] of [
  ['-p "1 +"', ['-p', '1 +']],
  ['-p "a b"', ['-p', 'a b']],
  ['ESM -e', ['--input-type=module', '-e', 'let let = 1']],
  ['BOM, CommonJS', ['bom.js']],
  ['BOM, ES module', ['bom.mjs']],
  ['an invalid character', ['at.js']],
  ['an unterminated string', ['str.js']],
  ["a module's strict word", ['ll.mjs']],
  ...tokens.map((src, i) => [`invalid token ${src}`, [`tok${i}.js`]]),
]) {
  const [status, err] = report(args);
  console.log(`== ${l} (${status})\n${err}`);
}
fs.rmSync(dir, { recursive: true, force: true });

for (const d of ['md5-sha1', 'shake128', 'shake256']) {
  for (const [n, f] of [
    ['hmac', () => crypto.createHmac(d, 'k').update('x').digest('hex')],
    ['hmac, a key past the block', () => crypto.createHmac(d, 'k'.repeat(100)).update('x').digest('hex')],
    ['pbkdf2', () => crypto.pbkdf2Sync('p', 's', 3, 40, d).toString('hex')],
    ['hkdf', () => Buffer.from(crypto.hkdfSync(d, 'k', 's', 'i', 8)).toString('hex')],
  ]) {
    try {
      console.log(d, n, f());
    } catch (e) {
      console.log(d, n, 'THROWS', e.name, e.code, e.message);
    }
  }
}
