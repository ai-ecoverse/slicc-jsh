const http = require('http');
const net = require('net');
const raw = (port, text, fin) =>
  new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1', () => (fin ? c.end(text) : c.write(text)));
    let out = '';
    c.on('data', (d) => {
      out += d;
      if (/handled \/\w$/.test(out)) c.end();
    });
    c.on('end', () => resolve(out.replace(/Date: [^\r]*\r\n/g, '')));
  });
const rows = [
  ['1.1 no Host', 'GET /a HTTP/1.1\r\nConnection: close\r\n\r\n'],
  ['1.1 empty Host', 'GET /b HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n'],
  ['1.0 no Host', 'GET /c HTTP/1.0\r\n\r\n'],
  ['1.1 no Host, a body', 'POST /f HTTP/1.1\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc'],
  ['1.1 no Host, keep-alive', 'GET /g HTTP/1.1\r\n\r\n'],
];
(async () => {
  for (const opts of [{}, { requireHostHeader: false }]) {
    const seen = [];
    const s = http.createServer(opts, (req, res) => {
      seen.push(req.url);
      res.end('handled ' + req.url);
    });
    s.on('clientError', (err) => seen.push('clientError ' + err.code));
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    console.log('requireHostHeader', s.requireHostHeader);
    for (const [label, text] of rows) console.log(label, JSON.stringify(await raw(s.address().port, text)));
    console.log('handled', seen.join(' '));
    s.close();
  }
  const early = [];
  const e = http.createServer((req, res) => {
    early.push(req.method + ' ' + req.url);
    res.end('handled ' + req.url);
  });
  e.on('upgrade', (req, sock) => {
    early.push('upgrade ' + req.url);
    sock.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\n');
  });
  await new Promise((r) => e.listen(0, '127.0.0.1', r));
  for (const [label, text, fin] of [
    ['the head only, a length, then FIN', 'POST /h HTTP/1.1\r\nContent-Length: 3\r\n\r\n', true],
    ['the head only, chunked, then FIN', 'POST /i HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n', true],
    ['an absolute-form target, then FIN', 'POST http://elsewhere.example/j HTTP/1.1\r\nContent-Length: 4\r\n\r\n', true],
    ['a large body never sent', 'POST /k HTTP/1.1\r\nContent-Length: 100000000\r\n\r\n', false],
    ['an upgrade', 'GET /l HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\n', false],
  ]) console.log(label, JSON.stringify(await raw(e.address().port, text, fin)));
  console.log('before the body', early.join(' | '));
  e.close();
  const s = http.createServer((req, res) => res.end('ok'));
  s.requireHostHeader = false;
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  console.log('set after create', JSON.stringify((await raw(s.address().port, rows[0][1])).split('\r\n')[0]));
  s.close();
  try {
    http.createServer({ requireHostHeader: 'yes' });
  } catch (err) {
    console.log('not a boolean', err.code, err.message);
  }
  console.log('https', require('https').createServer().requireHostHeader, require('https').createServer({ requireHostHeader: false }).requireHostHeader);
})();
