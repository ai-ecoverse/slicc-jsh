process.on('exit', () => console.log('exit event (should not run)'));
try { process.kill(process.pid, 'SIGTERM'); } finally { setTimeout(() => console.log('still alive 500ms later'), 500); }
