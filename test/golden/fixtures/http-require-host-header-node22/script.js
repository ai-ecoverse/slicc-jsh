const http = require('http');
const net = require('net');
const raw = (port, text) =>
  new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(text));
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
