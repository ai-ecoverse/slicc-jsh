require('child_process').exec('echo floating', (err, stdout, stderr) => {
  console.log('err', err, 'stdout', typeof stdout, Buffer.isBuffer(stdout), JSON.stringify(String(stdout)));
});
