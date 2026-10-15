const cp = require('child_process');
const e = (x) => x && { code: x.code, errno: x.errno, syscall: x.syscall, path: x.path, message: x.message };
let r = cp.spawnSync('yes', { maxBuffer: 100 }); console.log('maxBuffer', JSON.stringify({ status: r.status, signal: r.signal, len: r.stdout.length, error: e(r.error) }));
r = cp.spawnSync('yes', { maxBuffer: 100, killSignal: 'SIGKILL' }); console.log('maxBuffer kill9', JSON.stringify({ signal: r.signal, error: e(r.error) }));
try { cp.execSync('yes', { maxBuffer: 100 }); } catch (x) { console.log('execSync maxBuffer', x.code, x.signal, x.status, x.stdout.length, String(x.message).split('\n')[0]); }
let t0 = Date.now(); r = cp.spawnSync('sleep', ['5'], { timeout: 300 }); console.log('timeout', JSON.stringify({ status: r.status, signal: r.signal, error: e(r.error), fast: Date.now() - t0 < 3000 }));
r = cp.spawnSync('sleep', ['5'], { timeout: 300, killSignal: 'SIGINT' }); console.log('timeout SIGINT', r.signal, r.error.code);
try { cp.execSync('sleep 5', { timeout: 300 }); } catch (x) { console.log('execSync timeout', x.code, x.signal, x.status, String(x.message).split('\n')[0]); }
try { cp.execFileSync('sleep', ['5'], { timeout: 300, killSignal: 9 }); } catch (x) { console.log('execFileSync timeout', x.code, x.signal); }
r = cp.spawnSync('head', ['-c', '2000000', '/dev/zero'], { maxBuffer: Infinity }); console.log('maxBuffer Infinity 2MB', r.stdout.length, r.error && r.error.code);
r = cp.spawnSync('head', ['-c', '1048576', '/dev/zero']); console.log('default maxBuffer exactly 1MiB', r.stdout.length, r.error && r.error.code);
