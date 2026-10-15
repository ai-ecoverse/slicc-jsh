const { spawn, execFile } = require('child_process');
const c = spawn('definitely-not-a-cmd-xyz', ['a']);
c.on('error', (e) => {
  console.log('error', e.code, e.errno, e.syscall, e.path, JSON.stringify(e.spawnargs), e.message);
  execFile('definitely-not-a-cmd-xyz', (err) => console.log('execFile ENOENT', err.code, err.errno, err.syscall));
});
c.on('close', (code) => console.log('close after error', code));
