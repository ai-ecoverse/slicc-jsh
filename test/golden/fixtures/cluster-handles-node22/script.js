const cluster = require('cluster');
const net = require('net');
const http = require('http');

if (cluster.isWorker) {
  const server = http.createServer((req, res) => {
    res.end(`${cluster.worker.id} ${req.socket.remoteAddress} ${req.socket.remotePort}`);
  });
  server.listen(0, '127.0.0.1');
  process.on('message', (m) => {
    if (m === 'address') process.send(server.address());
  });
  return;
}

const out = [];
const get = (port) => new Promise((resolve) => {
  const socket = net.connect(port, '127.0.0.1', () => {
    socket.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  });
  let data = '';
  socket.on('data', (d) => (data += d));
  socket.on('end', () => {
    const [id, address, remotePort] = data.slice(data.indexOf('\r\n\r\n') + 4).split(' ');
    resolve({ id, peer: `${address} ${Number(remotePort) === socket.localPort ? "the client's own port" : 'another port'}` });
  });
});

const run = async (label, policy, count) => {
  cluster.schedulingPolicy = policy;
  const workers = [];
  for (let i = 0; i < count; i++) workers.push(cluster.fork());
  const ports = await Promise.all(workers.map((w) => new Promise((resolve) => w.once('listening', (address) => resolve(address.port)))));
  const port = ports[0];
  out.push(`${label}: every worker listens on one port ${ports.every((p) => p === port)}`);
  const addresses = await Promise.all(workers.map((w) => new Promise((resolve) => {
    w.once('message', (address) => resolve(address.port === port));
    w.send('address');
  })));
  out.push(`${label}: their address() is that port ${addresses.every(Boolean)}`);
  const ids = new Set();
  for (let i = 0; i < 4; i++) {
    const { id, peer } = await get(port);
    ids.add(id);
    out.push(`${label}: request ${i + 1}: the worker's socket sees ${peer}`);
  }
  out.push(`${label}: answered by ${ids.size === count ? 'every worker' : `${ids.size} of ${count} workers`}`);
  await new Promise((resolve) => cluster.disconnect(resolve));
  out.push(`${label}: disconnected`);
};

(async () => {
  out.push(`the default policy is SCHED_RR ${cluster.schedulingPolicy === cluster.SCHED_RR}`);
  await run('SCHED_RR', cluster.SCHED_RR, 2);
  await run('SCHED_NONE', cluster.SCHED_NONE, 1);
  for (const line of out) console.log(line);
})();
