const http = require('http');
const net = require('net');
const HEAD = (extra = '') => `POST /up HTTP/1.1\r\nHost: x\r\n${extra}\r\n`;
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
  console.log(`${label} | server: ${serverLog.splice(0).join(', ')}`);
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
  srv.close(() => console.log('closed'));
});
