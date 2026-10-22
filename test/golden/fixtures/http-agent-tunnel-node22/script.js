const http = require('http');
const UP = 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\n';
const OK = 'HTTP/1.1 200 Connection Established\r\n\r\n';
const tunnels = [];
const srv = http.createServer((req, res) => res.end('served ' + req.url));
const hold = (reply) => (req, sock) => {
  sock.resume();
  sock.on('end', () => sock.end());
  sock.write(reply);
  tunnels.push(sock);
};
srv.on('upgrade', hold(UP));
srv.on('connect', hold(OK));
const counts = (agent) => {
  const n = (o) => Object.values(o).reduce((a, l) => a + l.length, 0);
  return `sockets ${n(agent.sockets)} free ${n(agent.freeSockets)} requests ${n(agent.requests)} total ${agent.totalSocketCount}`;
};
const run = (port, connect) =>
  new Promise((resolve) => {
    const agent = new http.Agent({ maxSockets: 1 });
    const opts = connect
      ? { agent, host: '127.0.0.1', port, method: 'CONNECT', path: 'tunnel:1' }
      : { agent, host: '127.0.0.1', port, path: '/tunnel', headers: { Connection: 'Upgrade', Upgrade: 'x' } };
    const label = connect ? 'connect' : 'upgrade';
    const q = http.request(opts);
    let tunnel;
    q.on(connect ? 'connect' : 'upgrade', (res, sock) => {
      tunnel = sock;
      sock.resume();
      console.log(label, res.statusCode, 'agentRemove listeners', sock.listenerCount('agentRemove'), counts(agent));
      sock.on('close', () => {
        console.log(`  ${label} tunnel closed:`, counts(agent));
        agent.destroy();
        resolve();
      });
    });
    q.on('response', (res) => console.log('  unexpected response', res.statusCode));
    q.end();
    let pending = 2;
    const both = () => {
      if (--pending) return;
      console.log(`  ${label} second closed, tunnel open`, !tunnel.destroyed, counts(agent));
      tunnel.end();
    };
    const second = http.get({ agent, host: '127.0.0.1', port, path: '/second' }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (b += d));
      res.on('end', () => {
        console.log(`  ${label}: ${b}, tunnel open`, !tunnel.destroyed);
        both();
      });
    });
    second.on('socket', (s) => s.on('close', both));
    second.on('error', (e) => console.log('  second', e.code));
  });
srv.listen(0, '127.0.0.1', async () => {
  const { port } = srv.address();
  await run(port, false);
  await run(port, true);
  srv.close(() => console.log('closed'));
});
