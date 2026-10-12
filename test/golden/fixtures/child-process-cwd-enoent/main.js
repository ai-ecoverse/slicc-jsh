const { spawn, execFile } = require('child_process');
const fs = require('fs');

fs.rmSync('w-rc2', { recursive: true, force: true });
fs.mkdirSync('w-rc2/a/b', { recursive: true });
fs.writeFileSync('w-rc2/a/m', 'A');

const mask = (s) => String(s ?? '').split(process.cwd()).join('CWD');

function spawnOnce(cwd) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (s) => {
      if (done) return;
      done = true;
      resolve(s);
    };
    try {
      const c = spawn('node', ['-e', 'process.exit(0)'], { cwd, stdio: 'ignore' });
      c.on('error', (e) => finish(`ERR ${e.code} ${e.syscall} ${mask(e.path)}`));
      c.on('close', (code) => finish(`close ${code}`));
    } catch (e) {
      finish(`THROW ${e.code} ${e.syscall} ${e.errno}`);
    }
  });
}

function execOnce(cwd) {
  return new Promise((resolve) => {
    try {
      execFile('node', ['-e', 'process.exit(0)'], { cwd }, (e) => {
        resolve(e ? `ERR ${e.code} ${e.syscall} ${mask(e.path)}` : 'ok');
      });
    } catch (e) {
      resolve(`THROW ${e.code} ${e.syscall} ${e.errno}`);
    }
  });
}

(async () => {
  for (const cwd of ['w-rc2/nope', '/nonexistent-zz/abs', 'w-rc2/a/m']) {
    const sp = await spawnOnce(cwd);
    const ef = await execOnce(cwd);
    console.log(`cwd ${mask(cwd)} spawn=${sp} execFile=${ef}`);
  }
  fs.rmSync('w-rc2', { recursive: true, force: true });
})();
