const http = require('http'), https = require('https'), net = require('net');
const sh = (e) => `${e.name}|${e.code}|${e.errno}|${e.syscall}|${e.hostname ?? ''}|${e.address ?? ''}|${e.port ?? ''}|${e.message}`;
const get = (l, mod, u) => new Promise((r) => { const q = mod.get(u, (res) => { console.log(l, 'status', res.statusCode); res.resume(); res.on('end', r); }); q.on('error', (e) => { console.log(l, sh(e)); r(); }); q.setTimeout(8000, () => { console.log(l, 'timeout'); q.destroy(); }); });
(async () => {
  await get('http ENOTFOUND', http, 'http://no-such-host-zz.invalid/x');
  await get('https ENOTFOUND', https, 'https://no-such-host-zz.invalid/x');
  await get('http ECONNREFUSED', http, 'http://127.0.0.1:1/');
  await get('http ECONNREFUSED localhost', http, { host: 'localhost', port: 1, path: '/', family: 4 });
  await get('https ECONNREFUSED', https, 'https://127.0.0.1:1/');
  await new Promise((r) => { const c = net.connect(1, '127.0.0.1'); c.on('error', (e) => { console.log('net ECONNREFUSED', sh(e)); r(); }); });
  await new Promise((r) => { const c = net.connect(80, 'no-such-host-zz.invalid'); c.on('error', (e) => { console.log('net ENOTFOUND', sh(e)); r(); }); });
  await new Promise((r) => require('dns').lookup('no-such-host-zz.invalid', (e) => { console.log('dns.lookup', e ? sh(e) : 'ok'); r(); }));
  try { await fetch('http://no-such-host-zz.invalid/'); } catch (e) { console.log('fetch ENOTFOUND', e.name, e.message, e.cause?.code); }
})();
