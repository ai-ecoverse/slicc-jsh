const net = require('net');
const cp = require('child_process');

const peer = `
const net = require('net');
const c = net.connect(Number(process.argv[1]), '127.0.0.1', () => {
  c.pause();
  c.end();
  setTimeout(() => c.resume(), 300);
});
`;
const seen = [];
const big = () => Buffer.alloc(8 * 1024 * 1024, 120);

function row(label, serve, next) {
  const server = net.createServer({ allowHalfOpen: true }, (sock) => {
    sock.on('end', () => seen.push(`${label}: the peer ended`));
    sock.resume();
    serve(sock, (what) => {
      seen.push(`${label}: ${what}`);
      if (what === 'end callback') next?.();
    });
    server.close();
  });
  server.listen(0, '127.0.0.1', () => {
    cp.spawn(process.execPath, ['-e', peer, String(server.address().port)], { stdio: 'ignore', detached: true }).unref();
  });
}

row(
  'end(payload)',
  (sock, note) => sock.end(big(), () => note('end callback')),
  () =>
    row('a write, then end() on the peer end', (sock, note) => {
      sock.write(big(), () => note('write callback'));
      sock.on('end', () => sock.end(() => note('end callback')));
    })
);
process.on('exit', (code) => {
  for (const line of seen.sort()) console.log(line);
  console.log('exit', code);
});
