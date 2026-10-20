console.log('before stop');
process.kill(process.pid, 'SIGSTOP');
setTimeout(() => console.log('after CONT'), 10);
