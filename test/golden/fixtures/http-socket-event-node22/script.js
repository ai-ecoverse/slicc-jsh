const http = require('http');
const net = require('net');
const one = (label, port, agent) =>
  new Promise((resolve) => {
    const events = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
      res.resume();
      res.on('end', () => {
        events.push(`end: res.socket ${res.socket === null ? 'null' : 'set'}`);
        setImmediate(() => resolve(console.log(label, '|', events.join(', '))));
      });
    });
    events.push(`after http.get: req.socket ${Boolean(req.socket)}`);
    req.on('socket', (s) => {
      events.push(`socket: connecting ${s.connecting}, same ${s === req.socket}`);
      s.once('connect', () => events.push('connect'));
    });
    process.nextTick(() => events.push(`nextTick: req.socket ${Boolean(req.socket)}`));
  });
const srv = http.createServer((req, res) => res.end('ok'));
srv.listen(0, '127.0.0.1', async () => {
  const { port } = srv.address();
  await one('agent false', port, false);
  const plain = new http.Agent();
  await one('agent', port, plain);
  const ka = new http.Agent({ keepAlive: true });
  await one('keepAlive', port, ka);
  await one('keepAlive reused', port, ka);
  plain.destroy();
  ka.destroy();
  const state = (req, res) => `res.socket ${res.socket === null ? 'null' : 'set'}, req.destroyed ${req.destroyed}, writableFinished ${req.writableFinished}`;
  await new Promise((resolve) => {
    const agent = new http.Agent({ keepAlive: true });
    const events = [];
    const req = http.get({ host: '127.0.0.1', port, agent }, (res) => {
      res.prependListener('end', () => events.push(`prepended end: ${state(req, res)}`));
      res.on('end', () => events.push(`end: ${state(req, res)}`));
      res.resume();
    });
    req.on('close', () => {
      console.log('keepAlive, prepended end |', events.join('; '));
      agent.destroy();
      resolve();
    });
  });
  const early = net.createServer((s) => {
    let got = '';
    let answered = false;
    s.on('data', (d) => {
      got += d;
      if (!answered && got.includes('\r\n\r\n')) {
        answered = true;
        s.write('HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nContent-Length: 5\r\n\r\nearly');
      }
    });
  });
  await new Promise((r) => early.listen(0, '127.0.0.1', r));
  await new Promise((resolve) => {
    const agent = new http.Agent({ keepAlive: true });
    const events = [];
    const req = http.request({ host: '127.0.0.1', port: early.address().port, agent, method: 'POST', headers: { 'content-length': 8 } }, (res) => {
      res.on('end', () => {
        events.push(`end: ${state(req, res)}`);
        setTimeout(() => {
          req.on('finish', () => {
            events.push(`finish: ${state(req, res)}`);
            process.nextTick(() => events.push(`tick after finish: ${state(req, res)}`));
          });
          req.end('body');
        }, 20);
      });
      res.resume();
    });
    req.on('close', () => {
      console.log('keepAlive, response before the body is sent |', events.join('; '));
      agent.destroy();
      early.close(resolve);
    });
    req.write('half');
  });
  await new Promise((resolve) => {
    const agent = new http.Agent({ maxSockets: 1 });
    const events = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/headers', agent }, (res) => {
      res.on('end', () => events.push(`end: ${state(req, res)}, shouldKeepAlive ${req.shouldKeepAlive}`));
      res.resume();
    });
    req.on('close', () => {
      console.log('maxSockets 1 without keepAlive |', events.join('; '), '| sent', JSON.stringify(req.getHeader('connection') ?? /Connection: ([^\r]*)/.exec(req._header)?.[1]));
      agent.destroy();
      resolve();
    });
  });
  for (const when of ['sync', 'socket', 'connect']) {
    await new Promise((resolve) => {
      const events = [];
      const req = http.get({ host: '127.0.0.1', port, agent: false });
      if (when === 'sync') req.destroy();
      req.on('socket', (s) => {
        events.push('socket');
        if (when === 'socket') req.destroy();
        else if (when === 'connect') s.once('connect', () => req.destroy());
      });
      req.on('error', (e) => events.push(`error ${e.code} ${e.message}`));
      req.on('close', () => {
        console.log(`destroy at ${when} |`, events.concat('close').join(', '));
        resolve();
      });
    });
  }
  const fin = net.createServer((s) => {
    let got = '';
    s.on('data', (d) => {
      got += d;
      if (got.includes('\r\n\r\n')) s.end('HTTP/1.1 413 Payload Too Large\r\nContent-Length: 3\r\n\r\nbig');
    });
  });
  await new Promise((r) => fin.listen(0, '127.0.0.1', r));
  await new Promise((resolve) => {
    const events = [];
    const req = http.request({ host: '127.0.0.1', port: fin.address().port, method: 'PUT', headers: { 'content-length': 30000 } }, (res) => {
      events.push(`response ${res.statusCode}`);
      res.on('end', () => events.push('end'));
      res.resume();
    });
    req.on('error', (e) => events.push(`error ${e.code}`));
    req.on('close', () => {
      console.log('early response then FIN, still writing |', events.concat(`close, destroyed ${req.destroyed}, writableFinished ${req.writableFinished}`).join(', '));
      fin.close(resolve);
    });
    req.write(Buffer.alloc(1000));
  });
  srv.close();
});
