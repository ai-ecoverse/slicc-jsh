const cp = require('child_process');
const fs = require('fs');

const mask = (s) => String(s).split(process.cwd()).join('CWD');
const node = (src, opts) => cp.spawnSync('node', ['-e', src], opts);
const show = (label, fn) => {
  let s;
  try {
    s = JSON.stringify(fn(), (k, v) => (Buffer.isBuffer(v) ? `<Buffer ${v.toString('hex')}>` : v));
  } catch (e) {
    s = `THROW ${e.name} ${e.code}: ${e.message}`;
  }
  console.log(`${label}: ${mask(s)}`);
};

show('keys', () => Object.keys(node('process.stdout.write("hi")')));
show('buffers', () => {
  const r = node('process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3');
  return [r.status, r.signal, r.output, r.stdout, r.stderr, typeof r.pid, r.pid > 0];
});
show('utf8', () => {
  const r = node('process.stdout.write("h\\u00e9"); process.stderr.write("e")', { encoding: 'utf8' });
  return [r.output, r.stdout, r.stderr];
});
show('latin1', () => node('process.stdout.write(Buffer.from([0xe9]))', { encoding: 'latin1' }).stdout);
show('hex', () => node('process.stdout.write("AB")', { encoding: 'hex' }).stdout);
show('input string', () => node('process.stdin.pipe(process.stdout)', { input: 'piped', encoding: 'utf8' }).stdout);
show('input buffer', () => node('process.stdin.pipe(process.stdout)', { input: Buffer.from('buf') }).stdout);
show('input uint8', () => node('process.stdin.pipe(process.stdout)', { input: new Uint8Array([65, 66]) }).stdout);
show('input hex enc', () => node('process.stdin.pipe(process.stdout)', { input: '4142', encoding: 'hex' }).stdout);
show('input via stdio', () => node('process.stdin.pipe(process.stdout)', { stdio: [{ input: 'x' }, 'pipe', 'pipe'] }));
show('no input = eof', () => node('let n=0; process.stdin.on("data",d=>n+=d.length).on("end",()=>console.log("end",n))', { encoding: 'utf8' }).stdout);
show('ignore', () => {
  const r = node('console.log("gone"); console.error("gone")', { stdio: 'ignore' });
  return [Object.keys(r), r.status, r.output, r.stdout, r.stderr];
});
show('ignore stdout only', () => {
  const r = node('console.log("gone"); console.error("kept")', { stdio: ['pipe', 'ignore', 'pipe'], encoding: 'utf8' });
  return [r.output, r.stdout, r.stderr];
});
