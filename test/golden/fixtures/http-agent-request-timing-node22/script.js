const http = require('http');
const n = (o) => Object.values(o).reduce((a, l) => a + l.length, 0);
const run = (keepAlive) =>
  new Promise((resolve) => {
    const srv = http.createServer((req, res) => res.end('ok ' + req.url));
    srv.listen(0, '127.0.0.1', () => {
      const agent = new http.Agent({ keepAlive, maxSockets: 1 });
      const counts = () => `sockets ${n(agent.sockets)} free ${n(agent.freeSockets)} requests ${n(agent.requests)} total ${agent.totalSocketCount}`;
      const label = keepAlive ? 'keepAlive' : 'no keepAlive';
      let pending = 2;
      const get = (p) => {
        const req = http.get({ agent, host: '127.0.0.1', port: srv.address().port, path: p }, (res) => {
          let b = '';
          res.setEncoding('utf8');
          res.on('data', (d) => (b += d));
          res.on('end', () => {
            console.log(`  ${label} ${p} at end: ${b}, ${counts()}`);
            if (--pending === 0) {
              agent.destroy();
              srv.close(resolve);
            }
          });
        });
        return req;
      };
      const a = get('/a');
      console.log(label, 'after one request: socket', Boolean(a.socket), counts());
      get('/b');
      console.log(label, 'after two requests:', counts());
    });
  });
const unheard = (keepAlive) =>
  new Promise((resolve) => {
    const srv = http.createServer((req, res) => res.end('ok ' + req.url));
    srv.listen(0, '127.0.0.1', () => {
      const agent = new http.Agent({ keepAlive, maxSockets: 1 });
      const opts = { agent, host: '127.0.0.1', port: srv.address().port };
      http.get({ ...opts, path: '/unheard' });
      http.get({ ...opts, path: '/next' }, (res) => {
        res.setEncoding('utf8');
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => {
          console.log(keepAlive ? 'keepAlive' : 'no keepAlive', 'after a response nobody listens for:', b);
          agent.destroy();
          srv.close(resolve);
        });
      });
    });
  });
(async () => {
  await run(false);
  await run(true);
  await unheard(false);
  await unheard(true);
})();
