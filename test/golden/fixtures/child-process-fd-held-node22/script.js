const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'child-held-'));
const at = (n) => path.join(dir, n);
const late = `
const fs = require('fs');
const wait = () => (fs.existsSync(process.argv[1]) ? setTimeout(wait, 5) : write());
const write = () => {
  process.stdout.write('late out\\n');
  process.stderr.write('late err\\n');
};
wait();
`;
const buf = Buffer.alloc(64);
const read = (n) => (fs.existsSync(at(n)) ? JSON.stringify(fs.readFileSync(at(n), 'utf8')) : 'none');

let out = fs.openSync(at('out'), 'w');
let err = fs.openSync(at('err'), 'w');
fs.writeSync(out, 'head\n');
const c = cp.spawn('node', ['-e', late, at('err')], { stdio: ['ignore', out, err] });
fs.closeSync(out);
fs.closeSync(err);
fs.renameSync(at('out'), at('out-moved'));
fs.renameSync(at('err'), at('err-moved'));
c.on('close', (code, signal) => {
  console.log('closed after spawn, renamed away:', code, signal, 'stdout', read('out-moved'), 'stderr', read('err-moved'), 'at the old paths', read('out'), read('err'));

  fs.writeFileSync(at('both'), 'old');
  const both = fs.openSync(at('both'), 'r+');
  const c2 = cp.spawn('node', ['-e', late, at('both')], { stdio: ['ignore', both, both] });
  fs.writeFileSync(at('tmp'), 'the new file');
  fs.renameSync(at('tmp'), at('both'));
  fs.unlinkSync(at('both'));
  c2.on('close', (code2) => {
    console.log('kept open, replaced then unlinked:', code2, 'the descriptor reads', JSON.stringify(buf.toString('latin1', 0, fs.readSync(both, buf, 0, 64, 0))), 'the path', read('both'));
    fs.closeSync(both);
    fs.rmSync(dir, { recursive: true });
  });
});
