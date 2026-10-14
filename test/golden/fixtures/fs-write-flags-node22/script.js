// writeFile / appendFile (sync, callback, promises) with every flag on an
// existing and a missing file: 'ax' / 'ax+' / 'wx' / 'wx+' are exclusive
// (EEXIST on an existing one), 'a' / 'a+' append, 'w' replaces, 'r+' needs it.
const fs = require('fs');
const dir = require('os').tmpdir() + '/fs-write-flags-golden';
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir);
const f = (n) => `${dir}/${n}`;
const run = async (label, fn) => { try { await fn(); } catch (e) { console.log(label, 'THROWS', e.code, e.syscall, e.message.replace(dir, 'DIR')); return; } };
(async () => {
  for (const flag of ['ax', 'ax+', 'wx', 'wx+', 'a+', 'a', 'w', 'r+']) {
    for (const [api, call] of [
      ['writeFileSync', (p) => fs.writeFileSync(p, 'new', { flag })],
      ['writeFile', (p) => new Promise((res, rej) => fs.writeFile(p, 'new', { flag }, (e) => (e ? rej(e) : res())))],
      ['promises.writeFile', (p) => fs.promises.writeFile(p, 'new', { flag })],
      ['appendFileSync', (p) => fs.appendFileSync(p, 'new', { flag })],
      ['appendFile', (p) => new Promise((res, rej) => fs.appendFile(p, 'new', { flag }, (e) => (e ? rej(e) : res())))],
      ['promises.appendFile', (p) => fs.promises.appendFile(p, 'new', { flag })],
    ]) {
      const existing = f(`${api}-${flag}-existing`);
      fs.writeFileSync(existing, 'old;');
      await run(`${api} ${flag} existing`, () => call(existing));
      const missing = f(`${api}-${flag}-missing`);
      await run(`${api} ${flag} missing`, () => call(missing));
      console.log(api, flag, JSON.stringify(fs.readFileSync(existing, 'utf8')), fs.existsSync(missing) ? JSON.stringify(fs.readFileSync(missing, 'utf8')) : 'none');
    }
  }
})();
