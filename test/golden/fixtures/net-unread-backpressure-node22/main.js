const net = require('net');
const cp = require('child_process');
const SIZE = 1 << 20;

function unread(next) {
  const server = net.createServer((sock) => {
    sock.write(Buffer.alloc(SIZE, 7));
    sock.end();
    server.close();
  });
  server.listen(0, '127.0.0.1', () => {
    const c = net.connect(server.address().port, '127.0.0.1');
    c.on('connect', () => {
      setTimeout(() => {
        console.log('readableHighWaterMark', c.readableHighWaterMark, 'readableFlowing', c.readableFlowing);
        console.log('holds about its highWaterMark', c.readableLength > 0 && c.readableLength <= c.readableHighWaterMark + 65536);
        let got = 0;
        c.on('data', (d) => (got += d.length));
        c.on('end', () => {
          console.log('read on, got', got === SIZE ? 'every byte' : got);
          next();
        });
        c.resume();
      }, 300);
    });
  });
}

const never = `
const net = require('net');
const c = net.connect(Number(process.argv[1]), '127.0.0.1', () => console.log('connected'));
process.on('exit', (code) => console.log('exit', code, c.readableLength > 0 && c.readableLength < ${SIZE}));
`;
function neverReads() {
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.end(Buffer.alloc(SIZE, 7));
    server.close();
  });
  server.listen(0, '127.0.0.1', () => {
    const c = cp.spawn(process.execPath, ['-e', never, String(server.address().port)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('close', (code) => {
      console.log('a client that never reads what its peer sent and ended: status', code);
      process.stdout.write(out);
    });
  });
}

unread(neverReads);
