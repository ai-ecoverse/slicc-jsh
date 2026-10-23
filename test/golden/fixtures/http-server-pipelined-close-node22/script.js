const http = require('http');
const net = require('net');

const blockMs = Number(process.env.INJECT_BLOCK_MS) || 0;
const block = () => {
  const until = Date.now() + blockMs;
  while (Date.now() < until);
};
const strip = (s) => s.replace(/\r\nDate: [^\r\n]*/g, '');
const post = (url, length, body = '', extra = '') => `POST ${url} HTTP/1.1\r\nHost: x\r\nContent-Length: ${length}\r\n${extra}\r\n${body}`;
const get = (url, extra = '') => `GET ${url} HTTP/1.1\r\nHost: x\r\n${extra}\r\n`;
const ORDER = ['request', 'aborted', 'req error', 'end', 'finish', 'res close', 'req close'];

const shot = (label, { handler, send, create = {}, options = {}, clientError = true, onClientError, until, bound = 10000 }) =>
  new Promise((resolve) => {
    const urls = [];
    const seen = new Map();
    const conn = [];
    const note = (url, event) => {
      if (!seen.has(url)) {
        seen.set(url, []);
        urls.push(url);
      }
      seen.get(url).push(event);
    };
    const srv = http.createServer(create, (req, res) => {
      const url = req.url;
      note(url, 'request');
      req.on('aborted', () => note(url, 'aborted'));
      req.on('error', (e) => note(url, `req error ${e.code}`));
      req.on('end', () => note(url, 'end'));
      req.on('close', () => note(url, 'req close'));
      res.on('finish', () => note(url, 'finish'));
      res.on('close', () => note(url, 'res close'));
      handler(req, res);
    });
    Object.assign(srv, options);
    if (clientError) {
      srv.on('clientError', (e, s) => {
        conn.push(`clientError ${e.code}`);
        if (onClientError) onClientError(s);
        else s.destroy();
      });
    }
    srv.listen(0, '127.0.0.1', () => {
      const c = net.connect(srv.address().port, '127.0.0.1');
      let got = '';
      let open = false;
      const timer = setTimeout(() => {
        open = true;
        c.destroy();
      }, bound);
      c.on('connect', () => send(c));
      c.on('data', (d) => {
        got += d;
        if (until && until(got)) c.end();
      });
      c.on('end', () => conn.push('client end'));
      c.on('error', (e) => conn.push(`client error ${e.code}`));
      c.on('close', () => {
        clearTimeout(timer);
        srv.close(() => setImmediate(() => {
          const rows = urls.map((url) => {
            const events = seen.get(url);
            const counted = ORDER.flatMap((name) => {
              const hits = events.filter((e) => e === name || e.startsWith(`${name} `));
              return hits.length ? [hits.join(' ')] : [];
            });
            return `${url}: ${counted.join(', ')}`;
          });
          console.log(`${label} | ${rows.join(' | ') || 'no requests'} | ${conn.join(', ') || '-'}${open ? ' | open' : ' | closed'} | wire ${JSON.stringify(strip(got))}`);
          resolve();
        }));
        block();
      });
    });
  });

const answer = (req, res) => {
  req.resume();
  res.end(req.url);
};
const never = (req) => req.resume();
const atEnd = (req, res) => {
  req.resume();
  req.on('end', () => res.end(req.url));
};
const three = (last = '') => post('/a', 3, 'foo') + post('/b', 3, 'foo') + post('/c', 3, 'foo', last);

(async () => {
  await shot('fin with three buffered posts, the last one Connection: close', { handler: answer, send: (c) => c.end(three('Connection: close\r\n')) });
  await shot('the same posts without a fin', { handler: answer, send: (c) => c.write(three('Connection: close\r\n')) });
  await shot('fin with three buffered keep-alive posts', { handler: answer, send: (c) => c.end(three()) });
  await shot('fin after a partial body', { handler: answer, send: (c) => c.end(post('/a', 3, 'foo') + post('/b', 3, 'foo') + post('/c', 3, 'f')) });
  await shot('fin after a partial head', { handler: answer, send: (c) => c.end(post('/a', 3, 'foo') + post('/b', 3, 'foo') + 'POST /c HTTP/1.1\r\nHost: x\r\n') });
  await shot('fin after a partial head, no clientError listener', { handler: answer, clientError: false, send: (c) => c.end(post('/a', 3, 'foo') + 'POST /b HTTP/1.1\r\nHo') });
  await shot('fin while the first response is pending', { handler: (req, res) => (req.url === '/a' ? never(req) : answer(req, res)), send: (c) => c.end(three()) });
  await shot('fin while the second response is pending', { handler: (req, res) => (req.url === '/b' ? never(req) : answer(req, res)), send: (c) => c.end(three()) });
  await shot('fin after a partial chunk size', { handler: answer, send: (c) => c.end('POST /a HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n3') });
  await shot('fin after a bad head the clientError listener answers', {
    handler: answer,
    onClientError: (s) => s.write('HTTP/1.1 400 Bad Request\r\nX-Own: yes\r\n\r\n'),
    send: (c) => {
      c.write('GET /a HTTP/1.1\r\nHost: x\r\nBad Name: y\r\n\r\n');
      c.once('data', () => c.end());
    },
  });
  await shot('data after Connection: close, then fin', { handler: atEnd, send: (c) => c.end(get('/a', 'Connection: close\r\n') + get('/b')) });
  let client;
  await shot('fin with a request behind an upload that finished later', {
    handler: (req) => {
      req.resume();
      if (req.url !== '/a') return;
      req.on('end', () => client.end(get('/b')));
      client.write('o');
    },
    send: (c) => {
      client = c;
      c.write(post('/a', 3, 'fo'));
    },
  });
  await shot('fin on an idle kept-alive connection', { handler: answer, send: (c) => c.write(get('/a')), until: (got) => got.endsWith('/a') });
  await shot('a pipelined response before an upload that is still arriving', {
    options: { keepAliveTimeout: 50, keepAliveTimeoutBuffer: 0 },
    handler: (req, res) => {
      req.resume();
      if (req.url === '/a') setTimeout(() => res.end('A'), 10);
      else req.on('end', () => res.end('B'));
    },
    send: (c) => {
      c.write(get('/a') + post('/b', 4, '', 'Connection: close\r\n'));
      c.once('data', () => setTimeout(() => c.write('body'), 200));
    },
  });
  await shot('a partial next head on a kept-alive connection', {
    options: { keepAliveTimeout: 50, keepAliveTimeoutBuffer: 0 },
    handler: answer,
    send: (c) => {
      c.write(get('/a'));
      c.once('data', () => c.write('GET /b HTTP/1.1\r\nHo'));
    },
  });
  await shot('queued responses behind one that closes', {
    handler: (req, res) => res.end('ok'),
    send: (c) => c.write('GET /a HTTP/1.0\r\nConnection: keep-alive\r\n\r\n' + get('/b') + get('/c')),
  });
  await shot('queued responses when the client goes', {
    handler: (req, res) => (req.url === '/a' ? undefined : res.end('ok')),
    send: (c) => c.end(get('/a') + get('/b')),
  });
  await shot('req.destroy with a complete unread body', { handler: (req) => req.destroy(), send: (c) => c.write(post('/', 1, 'x')) });
  await shot('req.destroy during an upload', { handler: (req) => req.destroy(), send: (c) => c.write(post('/', 10, 'x')) });
  await shot('req.destroy on a get', { handler: (req) => req.destroy(), send: (c) => c.write(get('/')) });
  await shot('req.destroy with an error during an upload', { handler: (req) => req.destroy(new Error('boom')), send: (c) => c.write(post('/', 10, 'x')) });
  await shot('req.destroy after the body was read', {
    handler: (req) => {
      req.resume();
      req.on('end', () => req.destroy());
    },
    send: (c) => c.write(post('/', 1, 'x')),
    bound: 300,
  });
  await shot('an early Connection: close 413 before the upload', {
    handler: (req, res) => {
      res.setHeader('Connection', 'close');
      res.writeHead(413);
      res.end('rejected');
    },
    send: (c) => c.write(post('/', 1000000)),
  });
  await shot('an early Connection: close 413 during the upload', {
    handler: (req, res) => {
      res.writeHead(413, { Connection: 'close' });
      res.end('rejected');
    },
    send: (c) => c.write(post('/', 1000000, 'abc')),
  });
  await shot('an early Connection: close 413 during a chunked upload', {
    handler: (req, res) => {
      res.writeHead(413, { Connection: 'close' });
      res.end('rejected');
    },
    send: (c) => c.write('POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nab'),
  });
  await shot('a 408 for an upload that stops', {
    create: { requestTimeout: 100, headersTimeout: 50, connectionsCheckingInterval: 20 },
    handler: never,
    send: (c) => c.write(post('/', 10, 'ab')),
  });
  console.log('done');
})();
