const http = require('http'), net = require('net');
const t0 = Date.now(); const ms = () => Math.round((Date.now() - t0) / 250) * 250;
const step = (l, f) => f().then((r) => console.log(l, r), (e) => console.log(l, 'ERR', e.code, e.message));
let conns = 0;
const srv = http.createServer({ connectionsCheckingInterval: 200, headersTimeout: 800, requestTimeout: 800 }, (req, res) => {
  if (req.url === '/slow') { setTimeout(() => res.end('slow-done'), 700); return; }
  if (req.url === '/hangup') { req.socket.destroy(); return; }
  if (req.url === '/case') { res.setHeader('X-Mixed-Case', 'v'); res.end(JSON.stringify(req.rawHeaders.filter((h, i) => i % 2 === 0 && /mixed/i.test(h)))); return; }
  res.end('ok' + req.url);
});
srv.on('connection', () => conns++);
srv.on('upgrade', (req, sock, head) => { sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: x-test\r\nConnection: Upgrade\r\n\r\nhello-up'); sock.end(); });
srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  console.log('globalAgent keepAlive', http.globalAgent.keepAlive);
  const get = (p, o = {}) => new Promise((r, j) => http.get({ host: '127.0.0.1', port, path: p, ...o }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => r({ res, b })); }).on('error', j));
  await step('keepalive x3', async () => { conns = 0; const agent = new http.Agent({ keepAlive: true, maxSockets: 1 }); const o = []; for (const p of ['/a', '/b', '/c']) { const { res } = await get(p, { agent }); o.push(`${res.req.reusedSocket}/${res.headers.connection}/${res.headers['keep-alive']}`); } agent.destroy(); return `${o.join(' ')} conns=${conns}`; });
  await step('global agent x2', async () => { conns = 0; await get('/g1'); await get('/g2'); return `conns=${conns}`; });
  await step('pipelining', () => new Promise((r) => { const c = net.connect(port, '127.0.0.1', () => c.write('GET /p1 HTTP/1.1\r\nHost: x\r\n\r\nGET /p2 HTTP/1.1\r\nHost: x\r\n\r\nGET /p3 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')); let b = ''; c.on('data', (d) => (b += d)); c.on('close', () => r((b.match(/ok\/p\d/g) || []).join(','))); }));
  await step('headersTimeout 408', () => new Promise((r) => { const c = net.connect(port, '127.0.0.1', () => c.write('GET /x HTTP/1.1\r\nHost: x\r\n')); let b = ''; c.on('data', (d) => (b += d)); c.on('close', () => r(`${b.split('\r\n')[0]} at~${ms() > 0 ? 'later' : 'now'}`)); setTimeout(() => { c.destroy(); r('no close in 4s: ' + JSON.stringify(b.slice(0, 40))); }, 4000); }));
  await step('header case', async () => { const { res, b } = await get('/case', { headers: { 'X-Mixed-Req': '1' } }); return `${res.rawHeaders.filter((h) => /mixed/i.test(h)).join(',')} server-saw=${b}`; });
  await step('socket hang up', () => get('/hangup').then(() => 'no error'));
  await step('client upgrade', () => new Promise((r) => { const q = http.request({ host: '127.0.0.1', port, path: '/up', headers: { Connection: 'Upgrade', Upgrade: 'x-test' } }); q.on('upgrade', (res, sock, head) => { let b = head.toString(); sock.on('data', (d) => (b += d)); sock.on('end', () => r(`${res.statusCode} ${res.headers.upgrade} ${b}`)); }); q.on('response', (res) => r('response ' + res.statusCode)); q.on('error', (e) => r('err ' + e.code)); q.end(); }));
  await step('closeIdleConnections', () => new Promise((r) => { const agent = new http.Agent({ keepAlive: true }); let s; const q = http.get({ host: '127.0.0.1', port, path: '/i', agent }, (res) => { res.resume(); res.on('end', () => setTimeout(() => { const t = setTimeout(() => { agent.destroy(); r('still open after 1s'); }, 1000); s.once('close', () => { clearTimeout(t); agent.destroy(); r('client socket closed'); }); srv.closeIdleConnections(); }, 50)); }); q.on('socket', (x) => (s = x)); }));
  await step('closeAllConnections', () => new Promise((r) => { const q = http.get({ host: '127.0.0.1', port, path: '/slow', agent: false }, (res) => { res.resume(); res.on('end', () => r('completed?!')); res.on('error', () => {}); }); q.on('error', (e) => r('client ' + e.code)); setTimeout(() => srv.closeAllConnections(), 200); }));
  await step('close(cb) waits for busy', () => new Promise((r) => { const ev = []; const agent = new http.Agent({ keepAlive: true }); get('/slow', { agent }).then(({ b }) => ev.push('resp ' + b)); setTimeout(() => srv.close(() => { ev.push('close cb'); agent.destroy(); r(ev.join(' > ')); }), 200); }));
  console.log('done; listening', srv.listening);
});
