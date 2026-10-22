const http = require('http');
const net = require('net');

function get(port) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (row) => {
      if (settled) return;
      settled = true;
      resolve(row);
    };
    const req = http.get({ host: '127.0.0.1', port, agent: false }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('error', (e) => done({ status: res.statusCode, body: `${e.code} ${e.reason}` }));
      res.on('end', () => done({ status: res.statusCode, body: Buffer.concat(parts).toString('latin1') }));
      res.on('aborted', () => done({ status: res.statusCode, body: 'aborted' }));
    });
    req.on('error', (e) => done({ status: 0, body: `${e.code} ${e.reason}` }));
  });
}

function serve(reply) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buf = '';
      socket.on('data', (d) => {
        buf += d;
        if (!buf.includes('\r\n\r\n')) return;
        socket.end(reply);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function check(label, reply) {
  const server = await serve(reply);
  const got = await get(server.address().port);
  console.log(`${label} | ${got.status} | ${JSON.stringify(got.body)}`);
  await new Promise((r) => server.close(r));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

(async () => {
  await check(
    'chunked gzip close',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked, gzip\r\nConnection: close\r\n\r\nhi',
  );
  await check(
    'chunked gzip wire',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked, gzip\r\nConnection: close\r\n\r\n2\r\nhi\r\n0\r\n\r\n',
  );
  await check(
    'gzip chunked',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n2\r\nhi\r\n0\r\n\r\n',
  );
  await check(
    'identity close',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: identity\r\nConnection: close\r\n\r\nhi',
  );
  await check('bad crlf', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhi\n');
  await check(
    'cl then te',
    'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\nhi',
  );
  await check(
    'te then cl',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 2\r\n\r\n2\r\nhi\r\n0\r\n\r\n',
  );

  const events = [];
  const server = http.createServer((req, res) => {
    events.push(`request ${req.httpVersion} ${req.url}`);
    if (req.headers.expect !== undefined && req.httpVersion === '1.0') events.push('http10 expect');
    let body = '';
    req.on('data', (d) => {
      body += d;
    });
    req.on('end', () => {
      events.push(`body ${req.url} ${body}`);
      res.end('ok');
    });
    req.on('close', () => events.push(`close ${req.url}`));
  });
  server.on('checkContinue', (req, res) => {
    events.push(`continue ${req.headers.expect}`);
    res.writeContinue();
    req.resume();
    res.end('ok');
  });
  const port = await listen(server);
  const posted = (headers) =>
    new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port, agent: false, method: 'POST', path: '/e', headers: { ...headers, Host: 'x' } },
        (res) => {
          res.resume();
          const line = `status ${res.statusCode}`;
          res.on('end', () => resolve(line));
        },
      );
      req.end();
    });
  const rawStatus = (bytes) =>
    new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      let got = '';
      socket.on('connect', () => socket.end(bytes));
      socket.on('data', (d) => {
        got += d;
      });
      socket.on('close', () => resolve((got.match(/HTTP\/1\.[01] \d+/g) || []).join(' ')));
    });
  console.log('expect token |', await posted({ Expect: '100-continue, foo', 'Content-Length': '0' }));
  console.log('expect glued |', await posted({ Expect: '100-continuefoo', 'Content-Length': '0' }));
  console.log(
    'expect 1.0 |',
    await rawStatus('POST /e HTTP/1.0\r\nHost: x\r\nExpect: 100-continue\r\nContent-Length: 0\r\n\r\n'),
  );

  const mark = events.length;
  const raw = net.connect(port, '127.0.0.1');
  raw.on('data', () => {});
  await new Promise((resolve) => raw.on('connect', resolve));
  raw.end(
    'POST /a HTTP/1.1\r\nHost: x\r\nContent-Length: 3\r\n\r\nfooPOST /b HTTP/1.1\r\nHost: x\r\nContent-Length: 3\r\nConnection: close\r\n\r\nbar',
  );
  await new Promise((resolve) => raw.on('close', resolve));
  const piped = events.slice(mark);
  console.log(`pipeline | ${piped.join(' | ')}`);
  console.log(`server | ${events.slice(0, mark).join(' | ')}`);
  await new Promise((resolve) => server.close(resolve));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
