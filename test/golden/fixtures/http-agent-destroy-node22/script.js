const http = require('http');
const count = (a) =>
  ['sockets', 'freeSockets', 'requests']
    .map((k) => `${k}=${Object.values(a[k]).reduce((n, v) => n + v.length, 0)}/${Object.keys(a[k]).length}`)
    .join(' ') + ` total=${a.totalSocketCount}`;
let hold = [];
const server = http.createServer((req, res) => {
  if (req.url === '/hold') hold.push(res);
  else res.end('ok');
});
server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  const agent = new http.Agent({ keepAlive: true });
  const sockets = new Set();
  const get = (path) =>
    new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path, agent }, (res) => {
        res.resume();
        res.on('end', () => resolve(`${res.statusCode}`));
      });
      req.on('socket', (s) => sockets.add(s));
      req.on('error', (e) => resolve(e.code));
    });
  console.log('answers', (await Promise.all([1, 2, 3].map((i) => get(`/${i}`)))).join(' '));
  while (Object.keys(agent.sockets).length) await new Promise((r) => setImmediate(r));
  console.log('idle:', count(agent));
  const held = get('/hold');
  while (hold.length < 1) await new Promise((r) => setImmediate(r));
  console.log('one in use:', count(agent));
  let closed = 0;
  const allClosed = new Promise((resolve) => {
    for (const s of sockets)
      s.once('close', () => {
        closed++;
        const listed = ['sockets', 'freeSockets'].flatMap((k) => Object.values(agent[k]).flat());
        console.log(`close ${closed}: listed=${listed.length} self=${listed.includes(s)} total=${agent.totalSocketCount}`);
        if (closed === sockets.size) resolve();
      });
  });
  agent.destroy();
  console.log('after destroy:', count(agent));
  await allClosed;
  console.log('held request', await held);
  console.log('all closed:', count(agent));
  server.close();
});
