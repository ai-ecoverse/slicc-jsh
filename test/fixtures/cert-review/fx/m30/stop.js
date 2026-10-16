const t0 = Date.now(); console.log('before stop');
process.kill(process.pid, 'SIGSTOP');
setTimeout(() => console.log('after CONT, stopped ~', Math.round((Date.now() - t0) / 500) * 500, 'ms'), 10);
