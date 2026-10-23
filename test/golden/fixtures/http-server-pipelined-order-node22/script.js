const http = require('http');
const net = require('net');

const post = (url, body) => `POST ${url} HTTP/1.1\r\nHost: x\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
const chunked = (url, ...chunks) =>
  `POST ${url} HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n${chunks.map((c) => `${c.length.toString(16)}\r\n${c}\r\n`).join('')}0\r\n\r\n`;
const get = (url) => `GET ${url} HTTP/1.1\r\nHost: x\r\n\r\n`;

const shot = (label, { handler, packets, expect, responses = true }) =>
  new Promise((resolve) => {
    const log = [];
    const srv = http.createServer((req, res) => {
      const url = req.url;
      log.push(`request ${url}`);
      req.on('end', () => log.push(`end ${url}`));
      req.on('close', () => log.push(`req close ${url}`));
      if (responses) {
        res.on('finish', () => log.push(`finish ${url}`));
        res.on('close', () => log.push(`res close ${url}`));
      }
      handler(req, res, (event) => log.push(`${event} ${url}`));
    });
    srv.listen(0, '127.0.0.1', () => {
      const c = net.connect(srv.address().port, '127.0.0.1');
      let got = '';
      const answered = () => (got.match(/HTTP\/1\.1 200/g) || []).length;
      const queue = packets.map((p) => (typeof p === 'string' ? { text: p, after: 0 } : p));
      const send = () => {
        while (queue.length && answered() >= queue[0].after) c.write(queue.shift().text);
      };
      c.on('connect', send);
      c.on('data', (d) => {
        got += d;
        send();
        if (answered() === expect) c.end();
      });
      c.on('close', () => {
        setTimeout(() => {
          console.log(`${label}\n  ${log.join(', ')}`);
          srv.close(resolve);
        }, 50);
      });
    });
  });

const closing = (label, first, second) =>
  new Promise((resolve) => {
    const log = [];
    let c;
    const srv = http.createServer((req) => {
      log.push(`request ${req.url}`);
      req.resume();
      req.on('end', () => {
        log.push(`end ${req.url}`);
        if (req.url === '/a') c.write(second);
      });
    });
    srv.on('clientError', (e, s) => {
      log.push(`clientError ${e.code}`);
      s.destroy();
    });
    srv.listen(0, '127.0.0.1', () => {
      c = net.connect(srv.address().port, '127.0.0.1');
      c.on('connect', () => c.write(first));
      const bound = setTimeout(() => {
        log.push('still open');
        c.destroy();
      }, 5000);
      c.on('close', () => {
        clearTimeout(bound);
        console.log(`${label}\n  ${log.join(', ')}`);
        srv.close(resolve);
      });
    });
  });

const reading = (req, res, note) => {
  req.on('data', (d) => note(`data ${d}`));
};
const later = (req, res, note) => {
  reading(req, res, note);
  setTimeout(() => res.end('ok'), 30);
};
const atOnce = (req, res, note) => {
  reading(req, res, note);
  res.end('ok');
};
const atEnd = (req, res, note) => {
  reading(req, res, note);
  req.on('end', () => res.end('ok'));
};
const micro = (req, res, note) => {
  Promise.resolve().then(() => note('micro'));
  process.nextTick(() => note('tick'));
  reading(req, res, note);
  req.on('end', () => {
    Promise.resolve().then(() => note('end micro'));
    res.end('ok');
  });
};
const iterate = (req, res, note) => {
  (async () => {
    for await (const d of req) note(`chunk ${d}`);
    note('done');
    res.end('ok');
  })();
};

const four = [post('/a', 'foo') + post('/b', 'foo') + post('/c', 'foo') + post('/d', 'foo')];

(async () => {
  await shot('four posts in one packet, answered later', { handler: later, packets: [...four], expect: 4 });
  await shot('four posts in one packet, answered at once', { handler: atOnce, packets: [...four], expect: 4, responses: false });
  await shot('four posts in one packet, answered at the end of each', { handler: atEnd, packets: [...four], expect: 4, responses: false });
  await shot('ticks and microtasks of each request', { handler: micro, packets: [post('/a', 'foo') + post('/b', 'bar') + post('/c', 'baz')], expect: 3, responses: false });
  await shot('for await over each request', { handler: iterate, packets: [post('/a', 'foo') + post('/b', 'bar') + post('/c', 'baz')], expect: 3, responses: false });
  await shot('three gets in one packet', { handler: later, packets: [get('/a') + get('/b') + get('/c')], expect: 3 });
  await shot('chunked posts in one packet', { handler: later, packets: [chunked('/a', 'fo', 'o') + chunked('/b', 'bar') + get('/c')], expect: 3 });
  await shot('a pipelined request split over two packets', {
    handler: later,
    packets: [post('/a', 'foo') + post('/b', 'foo').slice(0, 20), { text: post('/b', 'foo').slice(20) + post('/c', 'foo'), after: 1 }],
    expect: 3,
    responses: false,
  });
  await closing('a request after a Connection: close one, in a later packet', `GET /a HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`, get('/b'));
  await closing('a request after an HTTP/1.0 one, in a later packet', `GET /a HTTP/1.0\r\n\r\n`, get('/b'));
  await shot('a body split over two packets, with a request behind it', {
    handler: later,
    packets: [post('/a', 'foo') + post('/b', 'foobar').slice(0, -3), { text: 'bar' + post('/c', 'foo'), after: 2 }],
    expect: 3,
    responses: false,
  });
})();
