const http = require('http');
const net = require('net');
const FLOOD = 8 * 1024 * 1024;
const sendAll = (c, head, fill, size, tail, end) => {
  c.write(head);
  let left = size;
  const step = () => {
    while (left > 0) {
      const n = Math.min(left, 65536);
      left -= n;
      if (!c.write(fill.repeat(n))) return c.once('drain', step);
    }
    if (tail !== undefined) c.write(tail);
    if (end) c.end();
  };
  step();
};
const server = (label, head, fill, tail) =>
  new Promise((resolve) => {
    const ev = [];
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        ev.push(`request ${req.url} ${JSON.stringify(req.headers.x ?? '')}${req.rawTrailers.length ? ` trailers ${JSON.stringify(req.rawTrailers)}` : ''}`);
        res.end('ok');
      });
    });
    srv.on('clientError', (e, s) => {
      ev.push(`clientError ${e.code} ${JSON.stringify(e.message)}`);
      s.destroy();
    });
    srv.listen(0, '127.0.0.1', () => {
      const c = net.connect(srv.address().port, '127.0.0.1');
      let got = '';
      c.on('connect', () => sendAll(c, head, fill, FLOOD, tail));
      c.on('data', (d) => {
        got += d;
        if (got.endsWith('ok')) c.end();
      });
      c.on('error', () => {});
      c.on('close', () => {
        console.log(`server, ${label} | ${ev.join(', ') || '-'} | ${got.split('\r\n')[0] || '-'}`);
        srv.close(resolve);
      });
    });
  });
const client = (label, head, fill, tail) =>
  new Promise((resolve) => {
    const srv = net.createServer((s) => {
      s.on('error', () => {});
      s.once('data', () => {
        sendAll(s, head, fill, FLOOD, tail, true);
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const ev = [];
      const req = http.get({ host: '127.0.0.1', port: srv.address().port, agent: false }, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => ev.push(`response ${res.statusCode} ${JSON.stringify(res.headers.x ?? '')} ${JSON.stringify(b)}`));
      });
      req.on('error', (e) => ev.push(`error ${e.code} ${JSON.stringify(e.message)}`));
      req.on('close', () => {
        console.log(`client, ${label} | ${ev.join(', ')}`);
        srv.close(resolve);
      });
    });
  });
(async () => {
  await server('junk after the version', 'GET / HTTP/1.1', 'x');
  await server('junk in the method', 'GET', 'X');
  await server('spaces before the target', 'GET', ' ', '/a HTTP/1.1\r\nHost: x\r\n\r\n');
  await server('spaces before the version', 'GET /a', ' ', 'HTTP/1.1\r\nHost: x\r\n\r\n');
  await server('whitespace before a value', 'GET /a HTTP/1.1\r\nHost: x\r\nX:', ' \t', 'v\r\n\r\n');
  await server('leading CRLFs', '', '\r\n', 'GET /a HTTP/1.1\r\nHost: x\r\n\r\n');
  await server('whitespace before a trailer value', 'POST /a HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nT:', ' ', 'v\r\n\r\n');
  await client('whitespace before a value', 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nX:', ' ', 'v\r\n\r\nhi');
  await client('leading CRLFs', '', '\r\n', 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi');
  await client('whitespace before a trailer value', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhi\r\n0\r\nT:', ' ', 'v\r\n\r\n');
  await client('junk after the status', 'HTTP/1.1 200', 'x');
  console.log('done');
})();
