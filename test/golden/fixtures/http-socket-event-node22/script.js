const http = require('http');
const one = (label, port, agent) =>
  new Promise((resolve) => {
    const events = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
      res.resume();
      res.on('end', () => {
        events.push(`end: res.socket ${res.socket === null ? 'null' : 'set'}`);
        setImmediate(() => resolve(console.log(label, '|', events.join(', '))));
      });
    });
    events.push(`after http.get: req.socket ${Boolean(req.socket)}`);
    req.on('socket', (s) => {
      events.push(`socket: connecting ${s.connecting}, same ${s === req.socket}`);
      s.once('connect', () => events.push('connect'));
    });
    process.nextTick(() => events.push(`nextTick: req.socket ${Boolean(req.socket)}`));
  });
const srv = http.createServer((req, res) => res.end('ok'));
srv.listen(0, '127.0.0.1', async () => {
  const { port } = srv.address();
  await one('agent false', port, false);
  const plain = new http.Agent();
  await one('agent', port, plain);
  const ka = new http.Agent({ keepAlive: true });
  await one('keepAlive', port, ka);
  await one('keepAlive reused', port, ka);
  plain.destroy();
  ka.destroy();
  srv.close();
});
