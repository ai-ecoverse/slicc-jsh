const http = require('http'); const net = require('net');
const row = (label, handler, { listener = false } = {}) => new Promise((resolve) => {
  const ev = [];
  const srv = http.createServer({ requestTimeout: 300, connectionsCheckingInterval: 50 }, (req, res) => {
    req.on('aborted', () => ev.push('aborted'));
    req.on('error', (e) => ev.push(`req error ${e.code}`));
    req.on('close', () => ev.push('req close'));
    res.on('close', () => ev.push('res close'));
    res.on('finish', () => ev.push('finish'));
    req.on('data', () => {});
    handler(req, res);
  });
  if (listener) srv.on('clientError', (e, s) => { ev.push(`clientError ${e.code}`); s.destroy(); });
  srv.listen(0, '127.0.0.1', () => {
    const c = net.connect(srv.address().port, '127.0.0.1');
    let got = '';
    c.on('connect', () => c.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\nabc'));
    c.on('data', (d) => (got += d));
    c.on('error', (e) => ev.push(`client ${e.code}`));
    c.on('close', () => srv.close(() => setImmediate(() => {
      console.log(`${label} | ${ev.join(', ')} | ${JSON.stringify(got.replace(/\r\nDate: [^\r\n]*/g, ''))}`);
      resolve();
    })));
  });
});
const started = (req, res) => { res.writeHead(200, { 'Content-Length': '100' }); res.write('partial'); };
const head = (req, res) => { res.writeHead(200, { 'Content-Length': '100' }); res.flushHeaders(); };
(async () => {
  for (const listener of [false, true]) {
    const tag = listener ? ', a clientError listener' : '';
    await row(`the response started${tag}`, started, { listener });
    await row(`only the head sent${tag}`, head, { listener });
    await row(`no response yet${tag}`, () => {}, { listener });
    await row(`a chunked response started${tag}`, (req, res) => res.write('partial'), { listener });
  }
  console.log('done');
})();
