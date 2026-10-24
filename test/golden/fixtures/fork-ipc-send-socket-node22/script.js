const { fork } = require('child_process');
const net = require('net');
const http = require('http');

if (process.send) {
  const server = http.createServer((req, res) => res.end(`the child answered ${req.url}`));
  process.on('message', (m, socket) => {
    if (socket === undefined) return process.send(`the child got ${m}`);
    process.send(`the child got ${m}: a net.Socket ${socket instanceof net.Socket}, readable ${socket.readable}, writable ${socket.writable}, remote ${socket.remoteAddress}`);
    if (m.startsWith('request')) {
      server.emit('connection', socket);
      socket.resume();
    } else {
      socket.on('close', () => process.send({ closed: m }));
      socket.end(`the child ended ${m}\n`);
    }
  });
  process.on('disconnect', () => server.close());
  return;
}

const out = [];
const cp = fork(__filename);
const closed = [];
const messages = [];
let onMessage = () => {};
cp.on('message', (m) => {
  if (m?.closed !== undefined) closed.push(m.closed);
  else messages.push(m);
  onMessage();
});
const until = (ready) => new Promise((resolve) => (onMessage = () => ready() && resolve())());
const nextMessage = () => until(() => messages.length > 0).then(() => messages.shift());
const allClosed = (n) => until(() => closed.length === n);
let onSocket;
const server = net.createServer({ pauseOnConnect: true }, (socket) => onSocket(socket));
const accepted = () => new Promise((resolve) => (onSocket = resolve));
const connections = () => new Promise((resolve) => server.getConnections((err, n) => resolve(`${err} ${n}`)));
const request = (path) => {
  const client = net.connect(server.address().port, '127.0.0.1');
  client.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n`);
  const answer = new Promise((resolve) => {
    let data = '';
    client.on('data', (d) => {
      data += d;
      if (data.includes('the child answered')) resolve(data.slice(data.indexOf('\r\n\r\n') + 4));
    });
  });
  return { client, answer };
};

server.listen(0, '127.0.0.1', async () => {
  for (const path of ['/one', '/two']) {
    const { client, answer } = request(path);
    const socket = await accepted();
    cp.send(`request ${path}`, socket, (err) => out.push(`send callback ${err}`));
    out.push(await nextMessage());
    out.push(`client ${path} read: ${await answer}`);
    out.push(`after ${path}: the parent's socket destroyed ${socket.destroyed}, connections ${await connections()}`);
    request[path] = client;
  }

  const clients = [];
  const sockets = [];
  for (let i = 0; i < 3; i++) {
    const client = net.connect(server.address().port, '127.0.0.1');
    let data = '';
    client.on('data', (d) => (data += d));
    clients.push(new Promise((resolve) => client.on('end', () => resolve(data.trim()))));
    sockets.push(await accepted());
  }
  out.push(`send a: ${cp.send('a', sockets[0])}`);
  out.push(`send plain: ${cp.send('plain')}`);
  out.push(`send b: ${cp.send('b', sockets[1])}`);
  let called;
  const callback = new Promise((resolve) => (called = resolve));
  out.push(`send c: ${cp.send('c', sockets[2], called)}`);
  for (let i = 0; i < 4; i++) out.push(await nextMessage());
  out.push(`c callback ${await callback}`);
  for (const data of await Promise.all(clients)) out.push(`client read: ${data}`);
  await allClosed(3);
  out.push(`the child closed ${closed.sort().join(', ')}`);
  out.push(`connections ${await connections()}`);

  server.close(() => {
    out.push('the server closed');
    cp.disconnect();
  });
  out.push(`close called, listening ${server.listening}`);
  setTimeout(() => {
    out.push('the clients end');
    request['/one'].end();
    request['/two'].end();
  }, 50);
});
cp.on('exit', (code) => {
  out.push(`child exit ${code}`);
  for (const line of out) console.log(line);
});
