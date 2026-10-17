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

show('file not string', () => cp.spawnSync(5));
show('file empty', () => cp.spawnSync(''));
show('file null byte', () => cp.spawnSync('no\0de'));
show('args not object', () => cp.spawnSync('node', 5));
show('options not object', () => cp.spawnSync('node', [], 'str'));
show('args as options', () => cp.spawnSync('node', { encoding: 'utf8', input: 'console.log("stdin script")' }).stdout);
show('arg null byte', () => cp.spawnSync('node', ['a\0b']));
show('cwd number', () => cp.spawnSync('node', { cwd: 5 }));
show('shell number', () => cp.spawnSync('node', { shell: 5 }));
show('timeout negative', () => cp.spawnSync('node', { timeout: -1 }));
show('timeout string', () => cp.spawnSync('node', { timeout: '5' }));
show('timeout Infinity', () => cp.spawnSync('node', { timeout: Infinity }));
show('maxBuffer negative', () => cp.spawnSync('node', { maxBuffer: -1 }));
show('killSignal unknown', () => cp.spawnSync('node', { killSignal: 'SIGNOPE' }));
show('killSignal 99', () => cp.spawnSync('node', { killSignal: 99 }));
show('killSignal object', () => cp.spawnSync('node', { killSignal: {} }));
show('stdio bogus', () => cp.spawnSync('node', { stdio: 'bogus' }));
show('stdio number', () => cp.spawnSync('node', { stdio: 5 }));
show('stdio object no fd', () => cp.spawnSync('node', { stdio: ['pipe', {}, 'pipe'] }));
show('stdio ipc', () => cp.spawnSync('node', { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }));
show('input number', () => cp.spawnSync('node', { input: 5 }));
show('input with encoding buffer', () => cp.spawnSync('node', { input: 'x', encoding: 'buffer' }));
show('env null byte', () => cp.spawnSync('node', { env: { 'A\0': 'x' } }));
show('windowsHide not bool', () => cp.spawnSync('node', { windowsHide: 1 }));
show('windowsHide ignored', () => node('console.log("wh")', { windowsHide: true, encoding: 'utf8' }).stdout);
show('detached not bool', () => cp.spawnSync('node', { detached: 'yes' }));
show('uid not int', () => cp.spawnSync('node', { uid: 1.5 }));
show('encoding unknown, no output', () => node('', { encoding: 'bogus' }).output);
show('encoding unknown', () => node('console.log(1)', { encoding: 'bogus' }));
