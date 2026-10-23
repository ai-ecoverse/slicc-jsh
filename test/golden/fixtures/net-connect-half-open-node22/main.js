const net = require('net');
const cp = require('child_process');
const client = (mode) => `
const net = require('net');
const mode = ${JSON.stringify(mode)};
const sock = net.connect({ port: Number(process.argv[1]), host: '127.0.0.1', allowHalfOpen: true });
if (mode.startsWith('unref before')) sock.unref();
if (mode === 'unref before, a timer') setTimeout(() => {}, 300);
sock.on('end', () => {
  console.log('end');
  if (mode === 'late end') setTimeout(() => sock.end(Buffer.alloc(4 << 20, 1), () => console.log('end callback')), 20);
  if (mode === 'ref after') { sock.unref(); sock.ref(); }
  if (mode === 'ref after, end(data)') { sock.unref(); sock.ref(); sock.end(Buffer.alloc(1 << 20, 1)); }
  if (mode.startsWith('unref before')) sock.end(Buffer.alloc(1 << 20, 1));
});
sock.on('finish', () => console.log('finish'));
sock.on('close', () => console.log('close'));
sock.resume();
process.on('exit', (code) => console.log('exit', code));
`;
const modes = ['nothing', 'late end', 'ref after', 'ref after, end(data)', 'unref before, a timer'];
const timeoutOption = () => {
  const server = net.createServer(() => {});
  server.listen(0, '127.0.0.1', () => {
    const sock = net.connect({ port: server.address().port, host: '127.0.0.1', timeout: 50 });
    console.log('== net.connect({ timeout: 50 }): socket.timeout', sock.timeout);
    sock.on('timeout', () => {
      console.log('timeout');
      sock.destroy();
      server.close();
    });
  });
};
const next = (i) => {
  if (i >= modes.length) return timeoutOption();
  const mode = modes[i];
  let got = 0;
  let serverDone;
  const served = new Promise((resolve) => (serverDone = resolve));
  const server = net.createServer({ allowHalfOpen: true }, (sock) => {
    sock.on('data', (d) => (got += d.length));
    sock.on('close', serverDone);
    sock.end();
    server.close();
  });
  server.listen(0, '127.0.0.1', () => {
    const c = cp.spawn(process.execPath, ['-e', client(mode), String(server.address().port)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('close', (code) => {
      served.then(() => {
        console.log(`== ${mode}: status ${code}, the server got ${got} bytes`);
        process.stdout.write(out);
        next(i + 1);
      });
    });
  });
};
next(0);
