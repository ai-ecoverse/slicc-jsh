const http = require('http');
const net = require('net');
const BODY = 100000;
const srv = net.createServer((s) => {
  let got = Buffer.alloc(0);
  s.on('data', (d) => {
    got = Buffer.concat([got, d]);
    const end = got.indexOf('\r\n\r\n');
    if (end < 0 || got.length - end - 4 < BODY) return;
    const head = got.subarray(0, end).toString('latin1');
    const framing = /transfer-encoding: *[^\r]*/i.exec(head)?.[0] ?? 'no transfer-encoding';
    const reply = `${head.split(' ')[0]} ${got.length - end - 4} body bytes, ${framing.toLowerCase()}`;
    s.end(`HTTP/1.1 200 OK\r\nContent-Length: ${reply.length}\r\nConnection: close\r\n\r\n${reply}`);
  });
});
const row = (label, opts, later = false) => new Promise((resolve) => {
  const ev = [];
  const req = http.request({ host: '127.0.0.1', port: srv.address().port, agent: false, ...opts }, (res) => {
    let b = '';
    res.on('data', (d) => (b += d));
    res.on('end', () => { ev.push(`response ${b}`); console.log(`${label} | ${ev.join(', ')}`); resolve(); });
  });
  req.on('error', (e) => { console.log(`${label} | ${ev.join(', ')}, error ${e.code}`); resolve(); });
  const send = () => {
    const w = req.write(Buffer.alloc(BODY, 97));
    ev.push(`write ${w} needDrain=${req.writableNeedDrain}`);
    if (w) req.end();
    else req.once('drain', () => { ev.push(`drain length=${req.writableLength}`); req.end(); });
  };
  if (later) req.on('socket', (s) => s.once('connect', () => setImmediate(send)));
  else send();
});
srv.listen(0, '127.0.0.1', async () => {
  await row('DELETE with a body', { method: 'DELETE' });
  await row('GET with a body', { method: 'GET' });
  await row('OPTIONS with a body', { method: 'OPTIONS' });
  await row('POST, Transfer-Encoding identity', { method: 'POST', headers: { 'Transfer-Encoding': 'identity' } });
  await row('DELETE, a write after the connect', { method: 'DELETE' }, true);
  srv.close();
});
