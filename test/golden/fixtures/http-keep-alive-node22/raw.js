const http = require('http'); const net = require('net');
let conns = 0;
const server = http.createServer((req, res) => { if (req.url === '/stream') { res.write('a'); setTimeout(() => res.end('b'), 10); return; } if (req.url === '/close') res.setHeader('Connection', 'close'); res.end('ok'); });
server.on('connection', () => conns++);
// Whether the server keeps the connection: once the answers (`n` of them)
// are in, a probe request on it gets a response if it is open, and the
// socket closes if it isn't. (It waited 300 ms instead, which a loaded
// machine outlasted before the first answer came: `1.1 OPEN: ""`, #241.)
const answers = (b) => {
  let count = 0;
  let rest = b;
  for (;;) {
    const head = rest.indexOf('\r\n\r\n');
    if (!rest.startsWith('HTTP/') || head === -1) return { count, rest };
    const headers = rest.slice(0, head);
    let end;
    const length = /content-length: (\d+)/i.exec(headers);
    if (length) end = head + 4 + Number(length[1]);
    else if (/transfer-encoding: chunked/i.test(headers)) {
      const last = rest.indexOf('\r\n0\r\n\r\n', head);
      end = last === -1 ? Infinity : last + 7;
    } else return { count, rest }; // read to the close
    if (rest.length < end) return { count, rest };
    count++;
    rest = rest.slice(end);
  }
};
const raw = (text, n = 1) => new Promise((resolve) => {
  const s = net.connect(server.address().port, '127.0.0.1', () => s.write(text));
  let b = '';
  let shown;
  let probing = false;
  const show = () => JSON.stringify((shown ?? b).replace(/Date: .*\r\n/g, ''));
  s.on('data', (d) => {
    b += d;
    if (!probing) {
      const got = answers(b);
      if (got.count < n) return;
      shown = b.slice(0, b.length - got.rest.length);
      probing = true;
      s.write('GET /probe HTTP/1.1\r\nHost: x\r\n\r\n');
    } else if (answers(b.slice(shown.length)).count >= 1) {
      s.destroy();
      resolve(`OPEN: ${show()}`);
    }
  });
  s.on('error', () => {});
  s.on('close', () => resolve(`CLOSED: ${show()}`));
});
server.listen(0, '127.0.0.1', async () => {
  console.log('1.1', await raw('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
  console.log('1.1 close', await raw('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
  console.log('1.0', await raw('GET / HTTP/1.0\r\n\r\n'));
  console.log('1.0 ka', await raw('GET / HTTP/1.0\r\nConnection: keep-alive\r\n\r\n'));
  console.log('stream', await raw('GET /stream HTTP/1.1\r\nHost: x\r\n\r\n'));
  console.log('stream 1.0', await raw('GET /stream HTTP/1.0\r\n\r\n'));
  console.log('res close', await raw('GET /close HTTP/1.1\r\nHost: x\r\n\r\n'));
  console.log('pipelined', await raw('GET /p1 HTTP/1.1\r\nHost: x\r\n\r\nGET /p2 HTTP/1.1\r\nHost: x\r\n\r\n', 2));
  console.log('upgrade no listener', await raw('GET /u HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n'));
  const s = net.connect(server.address().port, '127.0.0.1', () => s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
  s.once('data', () => { const t0 = Date.now(); server.close(() => console.log('server.close cb after', Date.now() - t0 < 1000 ? '<1s' : '>1s')); s.on('close', () => console.log('idle client socket closed by server.close')); });
});
