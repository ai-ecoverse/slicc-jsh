// cluster against host Node 22: the primary forks two workers; each serves
// http on the port the primary listens on.
const cluster = require('cluster');
const http = require('http');
const log = (...args) => console.log(...args);

if (cluster.isWorker) {
  const id = cluster.worker.id;
  process.on('message', (m) => {
    if (m === 'who') process.send({ id, isWorker: cluster.isWorker, isPrimary: cluster.isPrimary, unique: process.env.NODE_UNIQUE_ID, state: cluster.worker.state });
    if (m === 'quit') process.exit(4);
  });
  http
    .createServer((req, res) => res.end(`worker ${id}`))
    .listen(0, '127.0.0.1');
} else {
  const events = [];
  const record = (name) => (worker, ...rest) => events.push(`${name} ${worker.id}${rest.length && name === 'exit' ? ` ${rest.join(' ')}` : ''}`);
  for (const name of ['fork', 'online', 'listening', 'disconnect', 'exit']) cluster.on(name, record(name));
  const messages = [];
  cluster.on('message', (worker, message) => messages.push(`message from ${worker.id} ${JSON.stringify(message)}`));
  log('primary', cluster.isPrimary, cluster.isWorker, Object.keys(cluster.workers).length);

  const workers = [cluster.fork({ EXTRA: '1' }), cluster.fork()];
  let port;
  const listened = [];
  const listening = Promise.all(
    workers.map((worker) => new Promise((resolve) => worker.once('listening', (address) => {
      port = address.port;
      listened.push(`listening ${worker.id} ${address.addressType} ${address.address}`);
      resolve();
    })))
  );
  const get = () =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, agent: false }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });
  (async () => {
    await listening;
    log(listened.sort().join('\n'));
    const answered = new Set();
    for (let i = 0; i < 6; i++) answered.add(await get());
    log('answered by', JSON.stringify([...answered].sort()));
    log('same port from both', workers.every((w) => w.state === 'listening'));
    for (const worker of workers) worker.send('who');
    await new Promise((resolve) => {
      let n = 0;
      cluster.on('message', () => ++n === 2 && resolve());
    });
    log(messages.sort().join('\n'));
    // One worker leaves by disconnect, the other ends itself.
    const first = workers[0];
    const gone = new Promise((resolve) => first.once('exit', (code, signal) => {
      log('first exit', code, signal, 'exitedAfterDisconnect', first.exitedAfterDisconnect, 'state', first.state);
      resolve();
    }));
    first.disconnect();
    await gone;
    const second = workers[1];
    const ended = new Promise((resolve) => second.once('exit', (code, signal) => {
      log('second exit', code, signal, 'exitedAfterDisconnect', second.exitedAfterDisconnect);
      resolve();
    }));
    second.send('quit');
    await ended;
    log('workers left', Object.keys(cluster.workers).length);
    log('events', events.sort().join(', '));
    // A third one, killed.
    const third = cluster.fork();
    await new Promise((resolve) => third.once('online', resolve));
    third.kill();
    await new Promise((resolve) => third.once('exit', (code, signal) => {
      log('third exit', code, signal, 'dead', third.isDead());
      resolve();
    }));
    cluster.disconnect(() => log('cluster.disconnect done'));
  })();
}
