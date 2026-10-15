const got = [];
process.on('SIGUSR1', () => got.push('USR1')); process.on('SIGTERM', () => got.push('TERM')); process.on('SIGINT', () => got.push('INT')); process.on('SIGHUP', () => got.push('HUP'));
for (const s of ['SIGUSR1', 'SIGTERM', 'SIGINT', 'SIGHUP']) console.log('kill', s, process.kill(process.pid, s));
setTimeout(() => { console.log('handlers ran', got.join(',')); try { process.kill(process.pid, 'SIGBOGUS'); } catch (e) { console.log('bogus', e.code); } try { process.kill(999999, 0); } catch (e) { console.log('no such pid', e.code, e.syscall); } console.log('signal 0 self', process.kill(process.pid, 0)); }, 100);
