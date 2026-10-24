const { fork } = require('child_process');
const net = require('net');

if (process.send) {
  process.on('message', (m, socket) => {
    socket.write(`the child wrote for ${m}\n`, () => process.send(`the child wrote for ${m}`));
    socket.on('data', (d) => process.send(`the child read ${JSON.stringify(String(d))}`));
    socket.on('end', () => socket.end());
  });
  return;
}

const out = [];
const cp = fork(__filename);
const nextMessage = () => new Promise((resolve) => cp.once('message', resolve));

const run = async (keepOpen) => {
  const label = keepOpen ? 'keepOpen' : 'handed over';
  const server = net.createServer({ pauseOnConnect: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = net.connect(server.address().port, '127.0.0.1');
  let data = '';
  client.on('data', (d) => (data += d));
  const clientClosed = new Promise((resolve) => client.on('close', resolve));
  const socket = await new Promise((resolve) => server.once('connection', resolve));
  const errored = new Promise((resolve) => socket.once('error', (e) => resolve(e.code)));

  let sent;
  const callback = new Promise((resolve) => (sent = resolve));
  cp.send(label, socket, { keepOpen }, sent);
  out.push(`${label}: ${await nextMessage()}`);
  out.push(`${label}: send callback ${await callback}`);
  client.write(`the client wrote to ${label}`);
  out.push(`${label}: ${await nextMessage()}`);
  const connections = await new Promise((resolve) => server.getConnections((err, n) => resolve(n)));
  out.push(`${label}: connections ${connections}, the parent's socket destroyed ${socket.destroyed}`);
  let serverClosed;
  const written = await new Promise((resolve) =>
    socket.write('the parent wrote\n', (err) => {
      serverClosed = new Promise((closed) => server.close(closed));
      resolve(err ? err.code : null);
    })
  );
  out.push(`${label}: the parent's write ${written}`);
  if (!keepOpen) out.push(`${label}: the parent's socket error ${await errored}`);
  if (keepOpen) socket.end();
  client.end();
  await clientClosed;
  out.push(`${label}: the client read ${JSON.stringify(data)}`);
  await serverClosed;
  out.push(`${label}: the server closed`);
};

(async () => {
  await run(true);
  await run(false);
  cp.disconnect();
  cp.on('exit', (code) => {
    out.push(`child exit ${code}`);
    for (const line of out) console.log(line);
  });
})();
