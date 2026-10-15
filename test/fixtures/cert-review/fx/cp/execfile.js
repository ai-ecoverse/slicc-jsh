const { execFile, exec } = require('child_process');
execFile('echo', ['a b', 'c'], (err, stdout, stderr) => {
  console.log('execFile echo', err, JSON.stringify(stdout), JSON.stringify(stderr));
  execFile('sh', ['-c', 'echo x; exit 7'], (err2, so) => {
    console.log('execFile exit 7', err2 && err2.code, err2 && err2.killed, err2 && err2.signal, JSON.stringify(so), err2 && err2.message.split('\n')[0]);
    exec('echo "$GREETING from $(pwd)"; echo e >&2', { env: { ...process.env, GREETING: 'hi' }, cwd: '/tmp' }, (err3, so3, se3) => {
      console.log('exec env+cwd', err3, JSON.stringify(so3.replace('/private', '')), JSON.stringify(se3));
      exec('exit 2', (err4) => { console.log('exec exit 2', err4.code, err4.cmd); });
    });
  });
});
