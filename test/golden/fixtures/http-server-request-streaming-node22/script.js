const http = require('http');
const net = require('net');
const HEAD = (extra = '') => `POST /up HTTP/1.1\r\nHost: x\r\n${extra}\r\n`;
const chunk = (n) => `${n.toString(16)}\r\n${'Z'.repeat(n)}\r\n`;
const raw = (port, label, steps) =>
  new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1');
    let got = '';
    let step = 0;
    const next = () => {
      while (step < steps.length && (steps[step].after === undefined || got.includes(steps[step].after))) {
        const s = steps[step++];
        if (s.send !== undefined) c.write(s.send);
        if (s.end) c.end();
      }
    };
    c.on('connect', next);
    c.on('data', (d) => {
      got += d;
      next();
    });
    c.on('close', () => {
      const lines = got
        .split('\r\n')
        .filter((l) => l && (/^HTTP\/1\.1 /.test(l) || !l.includes(':')));
      console.log(`${label} | client got: ${lines.join(' / ')}`);
      resolve();
    });
  });
const serverLog = [];
const flushLog = (label) => {
  const events = serverLog.splice(0);
  const requests = [];
  const bodies = [];
  const closes = [];
  const other = [];
  for (const event of events) {
    if (event.startsWith('request ')) requests.push(event);
    else if (event.startsWith('body ')) bodies.push(event);
    else if (event === 'req close') closes.push(event);
    else other.push(event);
  }
  let server;
  if (other.length === 0 && requests.length > 1 && requests.length === bodies.length) {
    server = requests.map((req, i) => [req, bodies[i], closes[i]].filter(Boolean).join(', ')).join(', ');
  } else server = events.join(', ');
  console.log(`${label} | server: ${server}`);
};
const srv = http.createServer((req, res) => {
  const tag = req.headers['x-case'];
  serverLog.push(`request ${tag} complete ${req.complete}`);
  req.on('aborted', () => serverLog.push('aborted'));
  req.on('error', (e) => serverLog.push(`req error ${e.code} ${e.message}`));
  if (tag === 'early') {
    res.end('early answer');
    return;
  }
  if (tag === 'reject') {
    res.writeHead(413);
    res.end('too big');
    return;
  }
  if (tag === 'stream') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    req.on('data', (d) => {
      serverLog.push(`data ${d}`);
      res.write(`ack=${d}\r\n`);
    });
    req.on('end', () => {
      serverLog.push(`end complete ${req.complete}${req.trailers['x-t'] ? ' trailer ' + req.trailers['x-t'] : ''}`);
      res.end('done=1\r\n');
    });
    return;
  }
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    serverLog.push(`body ${JSON.stringify(b)}`);
    res.end('body=' + b);
  });
  req.on('close', () => serverLog.push('req close'));
});
srv.on('checkExpectation', (req, res) => {
  serverLog.push(`checkExpectation ${req.headers.expect}`);
  res.writeHead(417);
  res.end();
});
srv.listen(0, '127.0.0.1', async () => {
  const { port } = srv.address();
  await raw(port, 'early answer before the body, then the rest and a second request', [
    { send: HEAD('X-Case: early\r\nContent-Length: 8\r\n') + 'half' },
    { after: 'early answer', send: 'rest' + HEAD('X-Case: plain\r\nContent-Length: 2\r\n') + 'ok' },
    { after: 'body=ok', end: true },
  ]);
  flushLog('early');
  await raw(port, 'content-length upload streamed', [
    { send: HEAD('X-Case: stream\r\nContent-Length: 6\r\n') + 'aa' },
    { after: 'ack=aa', send: 'bb' },
    { after: 'ack=bb', send: 'cc' },
    { after: 'done=1', end: true },
  ]);
  flushLog('stream cl');
  await raw(port, 'chunked upload streamed, with a trailer', [
    { send: HEAD('X-Case: stream\r\nTransfer-Encoding: chunked\r\n') + '2\r\naa\r\n' },
    { after: 'ack=aa', send: '2\r\nbb\r\n' },
    { after: 'ack=bb', send: '0\r\nX-T: yes\r\n\r\n' },
    { after: 'done=1', end: true },
  ]);
  flushLog('stream chunked');
  await raw(port, 'expect 100-continue', [
    { send: HEAD('X-Case: plain\r\nExpect: 100-continue\r\nContent-Length: 4\r\n') },
    { after: '100 Continue', send: 'body' },
    { after: 'body=body', end: true },
  ]);
  flushLog('continue');
  await raw(port, 'an expectation the server does not meet', [{ send: HEAD('X-Case: plain\r\nExpect: something\r\nContent-Length: 0\r\n') }, { after: '417', end: true }]);
  flushLog('expectation');
  await raw(port, 'the client goes mid-body', [{ send: HEAD('X-Case: plain\r\nContent-Length: 10\r\n') + 'part' }, { after: undefined, end: true }]);
  await new Promise((r) => setTimeout(r, 50));
  flushLog('gone');
  srv.removeAllListeners('checkExpectation');
  srv.on('checkContinue', (req, res) => {
    serverLog.push(`checkContinue ${req.url}`);
    res.writeContinue();
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => res.end('cc=' + b));
  });
  await raw(port, 'a checkContinue listener', [
    { send: HEAD('X-Case: plain\r\nExpect: 100-continue\r\nContent-Length: 2\r\n') },
    { after: '100 Continue', send: 'hi' },
    { after: 'cc=hi', end: true },
  ]);
  flushLog('checkContinue');
  let ended = false;
  const head = net.createServer((s) => {
    s.once('data', (d) => {
      console.log('flushHeaders sends the head:', String(d).split('\r\n')[0], '| end() called yet:', ended);
      s.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n');
    });
  });
  await new Promise((r) => head.listen(0, '127.0.0.1', r));
  await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: head.address().port, method: 'POST', agent: false, headers: { 'content-type': 'text/plain' } }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.flushHeaders();
    setTimeout(() => {
      ended = true;
      req.end();
    }, 50);
  });
  head.close();
  await raw(port, 'an unread body larger than the high water mark, then the next request', [
    { send: HEAD('X-Case: early\r\nContent-Length: 70000\r\n') + 'Z'.repeat(70000) + HEAD('X-Case: plain\r\nContent-Length: 2\r\n') + 'ok' },
    { after: 'body=ok', end: true },
  ]);
  flushLog('unread');
  await raw(port, 'an early 413 on a large chunked upload, then the next request', [
    { send: HEAD('X-Case: reject\r\nTransfer-Encoding: chunked\r\n') + chunk(64 * 1024) },
    { after: '413', send: chunk(64 * 1024) + chunk(64 * 1024) + '0\r\n\r\n' + HEAD('X-Case: plain\r\nContent-Length: 2\r\n') + 'ok' },
    { after: 'body=ok', end: true },
  ]);
  flushLog('reject');
  srv.on('clientError', (err, socket) => {
    serverLog.push(`clientError ${err.code}`);
    socket.destroy();
  });
  const shot = (label, bytes) =>
    new Promise((resolve) => {
      const c = net.connect(port, '127.0.0.1');
      let got = '';
      c.on('connect', () => c.write(Buffer.from(bytes, 'latin1')));
      c.on('data', (d) => {
        got += d;
      });
      c.on('error', () => {});
      c.on('close', () => {
        const lines = got.split('\r\n').filter((l) => /^HTTP\/1\.1 /.test(l));
        console.log(`${label} | client got: ${lines.join(' / ') || '-'}`);
        resolve();
      });
    });
  const pipe = (head, rest = '') => `${head}${rest}GET /next HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`;
  const post = (headers, body = '') => pipe(`POST /a HTTP/1.1\r\nHost: x\r\n${headers}\r\n\r\n`, body);
  const strict = [
    ['chunk size rejects junk', post('Transfer-Encoding: chunked', '5 junk\r\nhello\r\n0\r\n\r\n')],
    ['chunk size rejects a 0x prefix', post('Transfer-Encoding: chunked', '0x5\r\nhello\r\n0\r\n\r\n')],
    ['chunk size rejects a sign', post('Transfer-Encoding: chunked', '-5\r\nhello\r\n0\r\n\r\n')],
    ['chunk size rejects a trailing space', post('Transfer-Encoding: chunked', '5 \r\nhello\r\n0\r\n\r\n')],
    ['chunk size allows an extension', post('Transfer-Encoding: chunked', '5;a="q s"\r\nhello\r\n0;b\r\n\r\n')],
    ['chunk extension rejects a space', post('Transfer-Encoding: chunked', '5; a\r\nhello\r\n0\r\n\r\n')],
    ['chunk data must end in CRLF', post('Transfer-Encoding: chunked', '5\r\nhelloXX0\r\n\r\n')],
    ['a last chunk is not any two bytes', post('Transfer-Encoding: chunked', '0AB')],
    ['chunk size overflow', post('Transfer-Encoding: chunked', '10000000000000000\r\n')],
    ['a trailer is kept', post('Transfer-Encoding: chunked', '0\r\nX-T: yes\r\n\r\n')],
    ['a trailer without a colon is rejected', post('Transfer-Encoding: chunked', '0\r\nbad-trailer\r\n\r\n')],
    ['a transfer-encoding trailer is rejected', post('Transfer-Encoding: chunked', '0\r\nTransfer-Encoding: chunked\r\n\r\n')],
    ['chunked is the final coding', post('Transfer-Encoding: gzip, chunked', '0\r\n\r\n')],
    ['chunked then gzip is rejected', post('Transfer-Encoding: chunked, gzip', '0\r\n\r\n')],
    ['not-chunked is rejected', post('Transfer-Encoding: not-chunked', '0\r\n\r\n')],
    ['an empty transfer-encoding is ignored', post('Transfer-Encoding:', '')],
    ['an empty transfer-encoding after content-length is rejected', 'POST /a HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nTransfer-Encoding:\r\n\r\n'],
    ['content-length together with chunked is rejected', post('Transfer-Encoding: chunked\r\nContent-Length: 0', '0\r\n\r\n')],
    ['content-length before chunked is rejected', post('Content-Length: 0\r\nTransfer-Encoding: chunked', '0\r\n\r\n')],
    ['a duplicate content-length is rejected', post('Content-Length: 5\r\nContent-Length: 5', 'hello')],
    ['content-length +5 is rejected', post('Content-Length: +5', 'hello')],
    ['content-length 05 is five bytes', post('Content-Length: 05', 'hello')],
    ['content-length above 2^64 is rejected', post('Content-Length: 18446744073709551616', '')],
    ['lf-only request lines are rejected', 'POST /lf HTTP/1.1\nHost: x\nContent-Length: 0\n\n'],
    ['a bare CR in a header is rejected', 'POST /cr HTTP/1.1\r\nHost: x\rX\r\nContent-Length: 0\r\n\r\n'],
    ['obs-fold is rejected', 'POST /fold HTTP/1.1\r\nHost: x\r\nX-A: one\r\n two\r\nContent-Length: 0\r\n\r\n'],
    ['a space in a header name is rejected', 'POST /h HTTP/1.1\r\nHost: x\r\nBad Name: y\r\nContent-Length: 0\r\n\r\n'],
    ['a control character in a header value is rejected', 'POST /h HTTP/1.1\r\nHost: x\r\nX-A: a\x01b\r\nContent-Length: 0\r\n\r\n'],
    ['a tab in a header value is kept', post('X-A: a\tb\r\nContent-Length: 0', '')],
    ['a lower-case method is rejected', 'post /a HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n'],
    ['HTTP/1.2 is rejected', 'POST /a HTTP/1.2\r\nHost: x\r\nContent-Length: 0\r\n\r\n'],
    ['an absolute URL is the target', 'GET http://x/a HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'],
    ['OPTIONS * is the target', post('Content-Length: 0', '').replace('POST /a', 'OPTIONS *')],
    ['HTTP/1.0 does not take a pipelined request', 'POST /a HTTP/1.0\r\nHost: x\r\nContent-Length: 0\r\n\r\nGET /next HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'],
    ['a header over the limit is rejected', `POST /a HTTP/1.1\r\nHost: x\r\nX-A: ${'b'.repeat(17000)}\r\nContent-Length: 0\r\n\r\n`],
  ];
  for (const [label, bytes] of strict) {
    await shot(label, bytes);
    flushLog(label);
  }
  const framed = net.createServer((s) => {
    const parts = [];
    s.on('data', (d) => {
      parts.push(d);
      const text = Buffer.concat(parts).toString('latin1');
      if (!text.includes('0\r\n\r\n')) return;
      console.log(`flushHeaders with transfer-encoding chunked: ${text.split('\r\n').slice(4).join(' ')}`);
      s.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n');
    });
  });
  await new Promise((r) => framed.listen(0, '127.0.0.1', r));
  await new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: framed.address().port, method: 'POST', agent: false, headers: { 'Transfer-Encoding': 'chunked' } },
      (res) => {
        res.resume();
        res.on('end', resolve);
      }
    );
    req.flushHeaders();
    req.write('hi');
    req.end('!');
  });
  framed.close();
  srv.close(() => console.log('closed'));
});
