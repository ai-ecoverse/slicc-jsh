console.log('kill(self, 0) ->', process.kill(process.pid, 0));
setTimeout(() => { console.log('before SIGTERM self'); process.kill(process.pid, 'SIGTERM'); setTimeout(() => console.log('still alive after SIGTERM'), 200); }, 10);
