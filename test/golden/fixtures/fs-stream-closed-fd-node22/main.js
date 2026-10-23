const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsh-g-'));
const f = path.join(dir, 'a.txt');
fs.writeFileSync(f, 'hello');
const show = (label, s) => new Promise((resolve) => {
  const seen = [];
  s.on('error', (e) => seen.push(`error ${e.code} ${e.syscall} ${e.message}`));
  s.on('close', () => { console.log(label, seen.join(' | ') || 'no error', 'close', s.destroyed); resolve(); });
});
(async () => {
  for (const kind of ['read', 'write']) {
    for (const when of ['destroy', 'destroy-err', 'end']) {
      const fd = fs.openSync(f, kind === 'read' ? 'r' : 'r+');
      const s = kind === 'read' ? fs.createReadStream(null, { fd }) : fs.createWriteStream(null, { fd });
      fs.closeSync(fd);
      const p = show(`${kind} ${when}`, s);
      if (when === 'destroy') s.destroy();
      else if (when === 'destroy-err') s.destroy(new Error('boom'));
      else if (kind === 'read') s.resume();
      else s.end('x');
      await p;
    }
  }
  fs.rmSync(dir, { recursive: true });
})();
