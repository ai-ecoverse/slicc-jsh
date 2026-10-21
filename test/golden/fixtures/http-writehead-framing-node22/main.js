const http = require('http');
const net = require('net');

const date = (s) => s.replace(/Date: [^\r]*\r\n/g, 'Date: <date>\r\n');

function snap(res) {
  return [
    `headersSent=${res.headersSent}`,
    `_headerSent=${res._headerSent}`,
    `writableEnded=${res.writableEnded}`,
    `finished=${res.finished}`,
    `chunkedEncoding=${res.chunkedEncoding}`,
    `shouldKeepAlive=${res.shouldKeepAlive}`,
    `_last=${res._last}`,
  ].join(' ');
}

function code(fn) {
  try {
    fn();
    return 'ok';
  } catch (err) {
    return `${err.name} ${err.code} ${err.message}`;
  }
}

const GET = (path, extra = '') => `GET ${path} HTTP/1.1\r\nHost: x\r\n${extra}\r\n`;
const HEAD = (path) => `HEAD ${path} HTTP/1.1\r\nHost: x\r\n\r\n`;
const GET10 = (path, extra = '') => `GET ${path} HTTP/1.0\r\n${extra}\r\n`;

const scenarios = [
  ['writeHead, then end(body)', GET('/a'), (res, step) => {
    res.writeHead(200);
    step('writeHead');
    res.end('body');
    step('end');
  }],
  ['writeHead with headers, then the header API', GET('/b'), (res, step, log) => {
    const ret = res.writeHead(201, { 'X-A': '1', 'Content-Type': 'text/plain' });
    log(`returns res ${ret === res}, statusMessage ${res.statusMessage}`);
    log(`getHeader ${res.getHeader('x-a')} names ${JSON.stringify(res.getHeaderNames())}`);
    log(`setHeader ${code(() => res.setHeader('X-B', '2'))}`);
    log(`removeHeader ${code(() => res.removeHeader('X-A'))}`);
    log(`writeHead again ${code(() => res.writeHead(200))}`);
    step('writeHead');
    res.end('ok');
    step('end');
  }],
  ['setHeader, writeHead, then end(body)', GET('/b2'), (res, step, log) => {
    res.setHeader('X-B', '2');
    res.writeHead(200, { 'X-A': '1' });
    log(`getHeaders ${JSON.stringify(res.getHeaders())}`);
    step('writeHead');
    res.end('body');
  }],
  ['end(body) alone', GET('/c'), (res, step) => {
    res.setHeader('X-B', '2');
    res.end('body');
    step('end');
  }],
  ['end() alone', GET('/d'), (res, step) => {
    res.end();
    step('end');
  }],
  ['writeHead, then end()', GET('/e'), (res, step) => {
    res.writeHead(200);
    res.end();
    step('end');
  }],
  ['an explicit Content-Length', GET('/f'), (res, step) => {
    res.writeHead(200, { 'Content-Length': '4' });
    step('writeHead');
    res.write('bo');
    step('write');
    res.end('dy');
    step('end');
  }],
  ['an explicit Transfer-Encoding', GET('/g'), (res, step) => {
    res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
    step('writeHead');
    res.write('a');
    res.end('b');
    step('end');
  }],
  ['write, then end(body)', GET('/h'), (res, step) => {
    res.write('a');
    step('write');
    res.end('b');
    step('end');
  }],
  ['HEAD, writeHead, then end(body)', HEAD('/i'), (res, step) => {
    res.writeHead(200);
    step('writeHead');
    res.end('body');
    step('end');
  }],
  ['HEAD, end(body)', HEAD('/j'), (res, step) => {
    res.end('body');
    step('end');
  }],
  ['HEAD, an explicit Content-Length', HEAD('/j2'), (res, step) => {
    res.setHeader('Content-Length', '4');
    res.end('body');
    step('end');
  }],
  ['204, writeHead, then end()', GET('/k'), (res, step) => {
    res.writeHead(204);
    step('writeHead');
    res.end();
    step('end');
  }],
  ['204, end(body)', GET('/l'), (res, step) => {
    res.statusCode = 204;
    res.end('x');
    step('end');
  }],
  ['304, writeHead with Transfer-Encoding', GET('/m'), (res, step) => {
    res.writeHead(304, { 'Transfer-Encoding': 'chunked' });
    step('writeHead');
    res.end();
    step('end');
  }],
  ['304, end(body)', GET('/m2'), (res, step) => {
    res.statusCode = 304;
    res.end('x');
    step('end');
  }],
  ['the response says Connection: close', GET('/n'), (res, step) => {
    res.writeHead(200, { Connection: 'close' });
    step('writeHead');
    res.end('x');
    step('end');
  }],
  ['the request says Connection: close', GET('/o', 'Connection: close\r\n'), (res, step) => {
    res.writeHead(200);
    step('writeHead');
    res.end('x');
    step('end');
  }],
  ['HTTP/1.0, writeHead, then end(body)', GET10('/p'), (res, step) => {
    res.writeHead(200);
    step('writeHead');
    res.end('body');
    step('end');
  }],
  ['HTTP/1.0, end(body)', GET10('/q'), (res, step) => {
    res.end('body');
    step('end');
  }],
  ['HTTP/1.0 keep-alive, an explicit Content-Length', GET10('/r', 'Connection: keep-alive\r\n'), (res, step) => {
    res.writeHead(200, { 'Content-Length': '2' });
    step('writeHead');
    res.end('ok');
    step('end');
  }],
  ['HTTP/1.0 keep-alive, end(body)', GET10('/r2', 'Connection: keep-alive\r\n'), (res, step) => {
    res.end('ok');
    step('end');
  }],
  ['HTTP/1.0 with TE: chunked, end(body)', GET10('/s', 'TE: chunked\r\n'), (res, step) => {
    res.end('body');
    step('end');
  }],
  ['HTTP/1.0 with TE: chunked, writeHead, then end(body)', GET10('/s2', 'TE: chunked\r\n'), (res, step) => {
    res.writeHead(200);
    res.end('body');
    step('end');
  }],
  ['writeHead, flushHeaders, then write and end', GET('/t'), async (res, step, log, head) => {
    res.writeHead(200, { 'X-A': '1' });
    step('writeHead');
    res.flushHeaders();
    step('flushHeaders');
    log(`client has ${JSON.stringify(date(await head))}`);
    res.write('a');
    step('write');
    res.end('b');
    step('end');
  }],
  ['flushHeaders alone, then end()', GET('/u'), async (res, step, log, head) => {
    res.flushHeaders();
    step('flushHeaders');
    log(`client has ${JSON.stringify(date(await head))}`);
    res.end();
    step('end');
  }],
  ['flushHeaders twice', GET('/u2'), (res, step) => {
    res.flushHeaders();
    res.flushHeaders();
    step('flushHeaders');
    res.end('x');
  }],
  ['Content-Length removed, end(body)', GET('/w'), (res, step) => {
    res.removeHeader('Content-Length');
    res.end('body');
    step('end');
  }],
  ['Content-Length and Transfer-Encoding removed, end(body)', GET('/v'), (res, step) => {
    res.removeHeader('Content-Length');
    res.removeHeader('Transfer-Encoding');
    res.end('body');
    step('end');
  }],
  ['Connection removed, end(body)', GET('/v2'), (res, step) => {
    res.removeHeader('Connection');
    res.end('body');
    step('end');
  }],
  ['a Trailer with a Content-Length', GET('/x'), (res, step, log) => {
    log(`writeHead ${code(() => res.writeHead(200, { 'Content-Length': '2', Trailer: 'X-T' }))}`);
    step('writeHead');
    res.end('ok');
    step('end');
  }],
  ['a Trailer, chunked', GET('/y'), (res, step) => {
    res.writeHead(200, { Trailer: 'X-T' });
    res.write('a');
    res.addTrailers({ 'X-T': '1' });
    res.end();
    step('end');
  }],
  ['an unknown status', GET('/z'), (res, step, log) => {
    res.writeHead(299);
    log(`statusMessage ${res.statusMessage}`);
    res.end();
  }],
  ['an invalid status', GET('/z2'), (res, step, log) => {
    log(`writeHead ${code(() => res.writeHead(99))}`);
    log(`writeHead ${code(() => res.writeHead(1000))}`);
    step('writeHead');
    res.end();
  }],
  ['a statusMessage set before writeHead', GET('/z3'), (res, step, log) => {
    res.statusMessage = 'Fine';
    res.writeHead(200);
    log(`statusMessage ${res.statusMessage}`);
    res.end();
  }],
  ['cork after the head, two writes, uncork', GET('/co'), (res, step) => {
    res.flushHeaders();
    res.cork();
    res.write('a');
    res.write('bc');
    step('corked');
    res.uncork();
    res.end();
  }],
  ['cork before the head, two writes, uncork', GET('/co2'), (res, step) => {
    res.cork();
    res.write('a');
    res.write('bc');
    step('corked');
    res.uncork();
    res.end();
  }],
  ['strictContentLength', GET('/sc'), (res, step, log) => {
    res.strictContentLength = true;
    res.writeHead(200, { 'Content-Length': '2' });
    log(`write ${code(() => res.write('abc'))}`);
    res.end('ok');
    step('end');
  }],
  ['strictContentLength, end short', GET('/sc2'), (res, step, log) => {
    res.strictContentLength = true;
    res.setHeader('Content-Length', '3');
    res.write('a');
    log(`end ${code(() => res.end('b'))}`);
    step('after');
    res.end('bc');
  }],
  ['strictContentLength, end(body) short of the length, then destroy', GET('/sc3'), (res, step, log) => {
    res.setHeader('Content-Length', '10');
    res.strictContentLength = true;
    log(`end ${code(() => res.end('hi'))}`);
    step('after');
    res.destroy();
  }],
  ['strictContentLength, end(body) short of the length, then end with the rest', GET('/sc4'), (res, step, log) => {
    res.setHeader('Content-Length', '10');
    res.strictContentLength = true;
    log(`end ${code(() => res.end('hi'))}`);
    step('after');
    res.write('abc');
    step('write');
    res.end('defgh');
    step('end');
  }],
  ['writeHead with a list', GET('/li'), (res, step) => {
    res.writeHead(200, ['X-A', '1', 'X-A', '2', 'Content-Length', '2']);
    step('writeHead');
    res.end('ok');
  }],
  ['writeHead with a list of pairs', GET('/li2'), (res, step) => {
    res.writeHead(200, [['X-A', '1'], ['Cookie', ['a=1', 'b=2']]]);
    step('writeHead');
    res.end('ok');
  }],
  ['end(buffer) and end(string), non-ASCII', GET('/u8'), (res, step) => {
    res.setHeader('X-N', '\u00e9');
    res.end('\u00fc');
    step('end');
  }],
  ['end(), a non-ASCII header', GET('/u82'), (res, step) => {
    res.setHeader('X-N', '\u00e9');
    res.end();
    step('end');
  }],
  ['end(buffer), a non-ASCII header', GET('/u83'), (res, step) => {
    res.setHeader('X-N', '\u00e9');
    res.end(Buffer.from('\u00fc'));
    step('end');
  }],
  ['write(string, latin1), a non-ASCII header', GET('/u84'), (res, step) => {
    res.setHeader('X-N', '\u00e9');
    res.write('\u00fc', 'latin1');
    res.end();
  }],
  ['Content-Disposition with a Content-Length', GET('/cd'), (res, step) => {
    res.setHeader('Content-Disposition', 'attachment; filename="\u00e9"');
    res.end('x');
    step('end');
  }],
  ['the response says Connection: keep-alive to a client that said close', GET('/ka', 'Connection: close\r\n'), (res, step) => {
    res.setHeader('Connection', 'keep-alive');
    res.end('x');
    step('end');
  }, 'end'],
  ['write after end', GET('/wae'), (res, step, log) => {
    res.on('error', (err) => log(`error ${err.code}`));
    res.end('x', () => {
      log(`write returns ${res.write('y', (err) => log(`write callback ${err && err.code}`))}`);
      res.end('z', (err) => log(`end callback ${err && err.code}`));
      res.end(() => log('end() callback'));
    });
  }],
  ['an end callback', GET('/cb'), (res, step, log) => {
    res.writeHead(200);
    res.end('x', () => log(`end callback ${snap(res)}`));
    step('end');
  }],
];

const handlers = new Map();

const server = http.createServer((req, res) => {
  if (req.url === '/next') {
    res.end('next');
    return;
  }
  const h = handlers.get(req.url);
  h.run(req, res);
});

function run(port, [name, text, handler, after]) {
  const path = text.split(' ')[1];
  const lines = [];
  const log = (s) => lines.push(`  ${s}`);
  let gotHead;
  const head = new Promise((r) => (gotHead = r));
  let closed;
  const resClosed = new Promise((r) => (closed = r));
  let reqClosed;
  const reqClose = new Promise((r) => (reqClosed = r));
  let kept;
  const keptAlive = new Promise((r) => (kept = r));
  handlers.set(path, {
    run(req, res) {
      let shown = null;
      const step = (what) => {
        log(`${what}: ${snap(res)}`);
        if (res._header !== shown) log(`  _header ${JSON.stringify(res._header && date(res._header))}`);
        shown = res._header;
      };
      step('start');
      for (const event of ['prefinish', 'finish']) {
        res.on(event, () => log(`${event}: ${snap(res)}${event === "finish" ? ` writableFinished=${res.writableFinished}` : ""}`));
      }
      req.on('close', () => reqClosed(res.closed ? 'after the response' : 'before the response'));
      res.on('close', () => {
        log(`close: ${snap(res)} writableFinished=${res.writableFinished}`);
        const s = req.socket;
        const open = !(s.destroyed || s.writableEnded);
        log(`kept alive ${open}`);
        kept(open);
        closed();
      });
      handler(res, step, log, head);
    },
  });
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    let wire = '';
    socket.on('data', (d) => {
      wire += d.toString('latin1');
      if (wire.includes('\r\n\r\n')) gotHead(wire);
    });
    socket.on('error', () => {});
    keptAlive.then((open) => {
      if (open && after === 'end') socket.end();
      else if (open) socket.write(GET('/next', 'Connection: close\r\n'));
    });
    socket.on('close', async () => {
      await resClosed;
      console.log(name);
      for (const line of lines) console.log(line);
      console.log(`  req close ${await reqClose}`);
      console.log(`  wire ${JSON.stringify(date(wire))}`);
      resolve();
    });
  });
}

const limited = http.createServer((req, res) => {
  if (req.url === '/next') {
    res.end('next');
    return;
  }
  handlers.get(req.url).run(req, res);
});

limited.maxRequestsPerSocket = 2;

const maxScenario = ['maxRequestsPerSocket', GET('/max'), (res, step) => {
  res.end('x');
  step('end');
}];

server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  for (const scenario of scenarios) await run(port, scenario);
  server.close();
  await new Promise((r) => limited.listen(0, '127.0.0.1', r));
  await run(limited.address().port, maxScenario);
  limited.close();
});
