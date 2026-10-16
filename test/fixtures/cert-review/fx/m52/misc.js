const http = require('http');
for (const mod of ['wasi', 'inspector', 'trace_events', 'node:inspector/promises']) { try { const x = require(mod); console.log(mod, 'loaded', typeof x); } catch (e) { console.log(mod, e.code); } }
console.log('STATUS_CODES', Object.keys(http.STATUS_CODES).length, http.STATUS_CODES[418], http.STATUS_CODES[425], http.STATUS_CODES[511]);
for (const u of ['ftp://x/', 'http://127.0.0.1:1/', 'ws://127.0.0.1:1/#frag', 'not a url']) { try { const w = new WebSocket(u); console.log('ws', u, 'constructed', w.url); w.onerror = () => {}; w.close(); } catch (e) { console.log('ws', u, e.name, e.message); } }
for (const p of [['a', 'a'], ['a b'], ['ok', 1], ['x']]) { try { const w = new WebSocket('ws://127.0.0.1:1/', p.length === 1 ? p[0] : p); console.log('proto', JSON.stringify(p), 'constructed'); w.onerror = () => {}; w.close(); } catch (e) { console.log('proto', JSON.stringify(p), e.name, e.message); } }
const cp = require('child_process');
console.log('PATH search spawnSync', cp.spawnSync('sh', ['-c', 'echo via-path'], { encoding: 'utf8' }).stdout.trim());
console.log('PATH env override', JSON.stringify(cp.spawnSync('sh', ['-c', 'echo x'], { encoding: 'utf8', env: { PATH: '/nonexistent' } }).error?.code));
console.log('umask', process.umask().toString(8));
setTimeout(() => process.exit(0), 300);
