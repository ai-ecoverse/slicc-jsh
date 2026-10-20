const http = require('http');
const net = require('net');
let conns = 0;
const server = http.createServer((req, res) => {
  res.end(`ok ${req.url} ${req.headers.connection}`);
});
server.on('connection', () => conns++);
server.on('upgrade', (req, socket, head) => {
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n');
  socket.on('data', (d) => socket.write(`echo:${d}`));
  if (head.length) socket.write(`head:${head}`);
});
// The agents' free sockets the server is closing, once each has closed:
// what a step after an idle timeout or closeIdleConnections() waits for
// (#361), not a fixed delay the client may not have seen the FIN within.
const freeClosed = (...agents) =>
  Promise.all(agents.flatMap((a) => Object.values(a.freeSockets).flat()).map((s) => (s.closed ? null : new Promise((r) => s.once('close', r)))));
const get = (path, opts = {}) =>
  new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: server.address().port, path, ...opts }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ body: b, conn: res.headers.connection, ka: res.headers['keep-alive'], reused: req.reusedSocket }));
    });
    req.on('error', (e) => resolve({ error: e.code }));
  });
server.listen(0, '127.0.0.1', async () => {
  console.log('globalAgent', http.globalAgent.keepAlive, http.globalAgent.options.timeout, http.globalAgent.scheduling);
  console.log('server', server.keepAliveTimeout, server.headersTimeout, server.requestTimeout, server.maxRequestsPerSocket);
  for (const p of ['/a', '/b', '/c']) console.log('global', JSON.stringify(await get(p)));
  console.log('conns after global', conns);
  const noka = new http.Agent({ keepAlive: false });
  for (const p of ['/d', '/e']) console.log('noka', JSON.stringify(await get(p, { agent: noka })));
  console.log('agent:false', JSON.stringify(await get('/f', { agent: false })));
  console.log('conns', conns);
  const one = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const c0 = conns;
  console.log('max1 par', JSON.stringify(await Promise.all(['/g', '/h', '/i'].map((p) => get(p, { agent: one })))));
  console.log('max1 new conns', conns - c0, 'free', Object.values(one.freeSockets).map((l) => l.length), 'sockets', Object.keys(one.sockets).length);
  server.keepAliveTimeout = 100;
  const c1 = conns;
  await get('/j', { agent: one });
  await freeClosed(one);
  console.log('after idle timeout free', Object.values(one.freeSockets).map((l) => l.length));
  console.log('after timeout', JSON.stringify(await get('/k', { agent: one })), 'new conns', conns - c1);
  server.keepAliveTimeout = 5000;
  await get('/l', { agent: one });
  server.closeIdleConnections();
  await freeClosed(one, http.globalAgent);
  console.log('after closeIdleConnections free', Object.values(one.freeSockets).map((l) => l.length));
  // upgrade
  await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/up', headers: { Connection: 'Upgrade', Upgrade: 'echo' } });
    req.on('upgrade', (res, socket, head) => {
      console.log('client upgrade', res.statusCode, res.headers.upgrade, JSON.stringify(String(head)));
      socket.write('hi');
      socket.once('data', (d) => {
        console.log('client got', String(d));
        socket.destroy();
        resolve();
      });
    });
    req.on('response', (res) => { console.log('response instead', res.statusCode); resolve(); });
    req.end();
  });
  await get('/m');
  server.close();
});
