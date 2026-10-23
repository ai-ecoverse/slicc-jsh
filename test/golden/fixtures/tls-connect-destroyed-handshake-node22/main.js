const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');

const read = (name) => fs.readFileSync(path.join(__dirname, 'keys', name), 'utf8');
const own = { key: read('server.key'), cert: read('server.crt') };
const a = { key: read('a.key'), cert: read('a.crt') };

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function client(port, c) {
  const socket = tls.connect({ host: '127.0.0.1', port, servername: 'a.test', rejectUnauthorized: false });
  socket.on('secureConnect', () => c.push('secureConnect'));
  socket.on('error', (err) => c.push(`error ${err.code}`));
  socket.on('close', (hadError) => c.push(`close ${hadError}`));
  return socket;
}

function report(name, s, c) {
  console.log(name);
  for (const line of s) console.log('  server', line);
  for (const line of c) console.log('  client', line);
}

(async () => {
  {
    const s = [];
    const c = [];
    let socket;
    let left;
    const gone = new Promise((resolve) => (left = resolve));
    const server = net.createServer((raw) => {
      raw.once('data', () => {
        s.push('the hello');
        socket.destroy();
      });
      raw.on('end', () => s.push('end'));
      raw.on('close', () => {
        s.push('close');
        left();
      });
    });
    const port = await listen(server);
    socket = client(port, c);
    await gone;
    server.close();
    report('a server that never answers the hello', s, c);
  }

  {
    const s = [];
    const c = [];
    let socket;
    let answer;
    let settled;
    const outcome = new Promise((resolve) => (settled = resolve));
    const server = tls.createServer({
      ...own,
      SNICallback(servername, cb) {
        s.push(`SNICallback ${servername}`);
        answer = () => cb(null, tls.createSecureContext(a));
        socket.destroy();
      },
    });
    server.on('secureConnection', () => {
      s.push('secureConnection');
      settled();
    });
    server.on('tlsClientError', (err) => {
      s.push(`tlsClientError ${err.code}`);
      settled();
    });
    const port = await listen(server);
    socket = client(port, c);
    socket.on('close', () => setTimeout(() => answer(), 100));
    await outcome;
    server.close();
    report('a tls.Server whose SNICallback answers after the client left', s, c);
  }
})();
