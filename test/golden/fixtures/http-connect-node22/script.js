const http = require('http');
const net = require('net');

const seen = [];
const raw = (port, text, { fin = false, until = null } = {}) =>
  new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1', () => (fin ? c.end(text) : c.write(text)));
    let out = '';
    c.on('data', (d) => {
      out += d;
      if (until && out.includes(until)) c.end();
    });
    c.on('close', () => resolve(out.replace(/Date: [^\r]*\r\n/g, '')));
  });
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

async function servers() {
  const plain = http.createServer((req, res) => {
    seen.push(`request ${req.method} ${req.url}`);
    res.end('handled');
  });
  const port = await listen(plain);
  console.log('no connect listener:', JSON.stringify(await raw(port, 'CONNECT example:443 HTTP/1.1\r\nHost: example:443\r\n\r\n')));
  plain.close();

  const proxy = http.createServer((req, res) => {
    seen.push(`request ${req.method}`);
    res.end('handled');
  });
  proxy.on('connect', (req, socket, head) => {
    seen.push(`connect ${req.method} ${req.url} ${req.httpVersion} ${JSON.stringify(req.headers).replace(/127\.0\.0\.1:\d+/, '127.0.0.1:PORT')} head ${JSON.stringify(String(head))} ${socket instanceof net.Socket}`);
    let ended = false;
    let ready = false;
    socket.on('data', (d) => socket.write(`echo ${d}`));
    socket.on('end', () => {
      ended = true;
      if (ready) socket.end('bye');
    });
    setTimeout(() => {
      socket.write(`HTTP/1.1 200 Connection Established\r\n\r\n${head.length ? `head ${head}` : ''}`);
      ready = true;
      if (ended) socket.end('bye');
    }, 20);
  });
  const proxyPort = await listen(proxy);
  console.log('a tunnel, what came with the head echoed:', JSON.stringify(await raw(proxyPort, 'CONNECT example:443 HTTP/1.1\r\nHost: example:443\r\n\r\nearly', { until: 'head early' })));
  console.log('FIN right after the head:', JSON.stringify(await raw(proxyPort, 'CONNECT example:80 HTTP/1.1\r\nHost: example:80\r\n\r\n', { fin: true })));
  return { proxy, proxyPort };
}

async function clients({ proxy, proxyPort }) {
  const head = [];
  const fake = net.createServer((sock) => {
    sock.once('data', (d) => {
      head.push(String(d).replace(/:\d+\r\n/, ':PORT\r\n'));
      const status = String(d).includes('denied') ? '407 Proxy Authentication Required' : '200 Connection Established';
      sock.write(`HTTP/1.1 ${status}\r\nX-Proxy: fake\r\n\r\nfrom the tunnel`);
    });
  });
  const fakePort = await listen(fake);
  const connect = (path, withListener = true) =>
    new Promise((resolve) => {
      const events = [];
      const req = http.request({ host: '127.0.0.1', port: fakePort, method: 'CONNECT', path });
      if (withListener) {
        req.on('connect', (res, socket, head) => {
          events.push(`connect ${res.statusCode} ${res.statusMessage} ${res.headers['x-proxy']} head ${JSON.stringify(String(head))} ${socket instanceof net.Socket}`);
          socket.destroy();
        });
      }
      req.on('response', (res) => events.push(`response ${res.statusCode}`));
      req.on('error', (e) => events.push(`error ${e.code}`));
      req.on('close', () => {
        events.push('close');
        setTimeout(() => resolve(events), 20);
      });
      req.end();
    });
  console.log('client, 200:', (await connect('example:443')).join(' | '));
  console.log('client, 407:', (await connect('denied:443')).join(' | '));
  console.log('client, no connect listener:', (await connect('example:8443', false)).join(' | '));
  console.log('the head the client sent:', JSON.stringify(head[0]));
  fake.close();

  const through = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: 'inner:1' });
    req.on('connect', (res, socket) => {
      let got = '';
      socket.on('data', (d) => (got += d));
      socket.on('end', () => resolve(`${res.statusCode} ${JSON.stringify(got)}`));
      socket.end('ping');
    });
    req.end();
  });
  console.log('client through the proxy:', through);
  proxy.close();
}

async function paused() {
  let readLater;
  const s = http.createServer();
  s.on('connect', (req, socket) => {
    console.log('server: the socket at connect is paused,', socket.readableFlowing);
    socket.write('HTTP/1.1 200 OK\r\n\r\n');
    readLater = () =>
      setTimeout(() => {
        let got = '';
        socket.on('data', (d) => {
          got += d;
          if (got.includes('later')) socket.end(`got ${got}`);
        });
      }, 50);
  });
  const port = await listen(s);
  const out = await new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1', () => c.write('CONNECT x:1 HTTP/1.1\r\nHost: x:1\r\n\r\n'));
    let text = '';
    c.on('data', (d) => {
      text += d;
      if (text.endsWith('\r\n\r\n') && !text.includes('got')) c.write('later', () => readLater());
    });
    c.on('close', () => resolve(text));
  });
  console.log('server: what came before a data listener is kept:', JSON.stringify(out));
  s.close();

  const fake = net.createServer((sock) => {
    sock.on('data', (d) => {
      const t = String(d);
      if (t.startsWith('CONNECT')) sock.write('HTTP/1.1 200 OK\r\n\r\n');
      else if (t.startsWith('GET')) sock.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
    });
  });
  const fakePort = await listen(fake);
  const agent = new http.Agent({ maxSockets: 1 });
  await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: fakePort, method: 'CONNECT', path: 'y:2', agent });
    req.on('connect', (res, tunnel) => {
      console.log('client: the tunnel at connect is paused,', tunnel.readableFlowing, 'and out of the agent:', Object.keys(agent.sockets).length, tunnel.listenerCount('free'), tunnel.listenerCount('agentRemove'));
      http.get({ host: '127.0.0.1', port: fakePort, agent }, (r) => {
        let body = '';
        r.on('data', (d) => (body += d));
        r.on('end', () => {
          console.log('client: a GET on the same agent (maxSockets 1) while the tunnel is open:', body, !tunnel.destroyed);
          tunnel.destroy();
          agent.destroy();
          fake.close();
          resolve();
        });
      });
    });
    req.end();
  });
}

servers()
  .then(clients)
  .then(paused)
  .then(() => console.log('seen:', seen.join(' | ')));
