const http = require('http');
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => res.end(`${req.method} ${req.url}${body ? ` ${body}` : ''}`));
});
server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  for (const [maxSockets, keepAlive] of [[1, false], [1, true], [2, false], [2, true]]) {
    const agent = new http.Agent({ maxSockets, keepAlive });
    let closes = 0;
    const request = (i, method = 'GET', data) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(`${i} TIMEOUT`), 5000);
        const req = http.request({ host: '127.0.0.1', port, path: `/${i}`, method, agent }, (res) => {
          let b = '';
          res.on('data', (d) => (b += d));
          res.on('end', () => {
            clearTimeout(timer);
            resolve(`${res.statusCode} ${b}`);
          });
        });
        req.on('close', () => closes++);
        req.on('error', (e) => {
          clearTimeout(timer);
          resolve(`${i} ${e.code}`);
        });
        req.end(data);
      });
    const seq = [];
    for (let i = 0; i < 3; i++) seq.push(await request(i));
    const par = await Promise.all([3, 4, 5, 6].map((i) => request(i)));
    const post = await Promise.all([request(7, 'POST', 'seven'), request(8, 'POST', 'eight'), request(9)]);
    await new Promise((r) => setTimeout(r, 50));
    console.log(`maxSockets ${maxSockets} keepAlive ${keepAlive}`);
    console.log('  sequential', JSON.stringify(seq));
    console.log('  parallel', JSON.stringify(par));
    console.log('  posts', JSON.stringify(post));
    console.log('  closes', closes);
    agent.destroy();
  }
  // The order Node gives: req 'finish', res 'end', res 'close', then req 'close'; a refused connect: 'error', then 'close'.
  await new Promise((resolve) => {
    const ev = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/order', agent: false }, (res) => {
      res.on('end', () => ev.push('res end'));
      res.on('close', () => ev.push('res close'));
      res.resume();
    });
    req.on('finish', () => ev.push('req finish'));
    req.on('close', () => {
      ev.push(`req close destroyed=${req.destroyed}`);
      console.log('order:', ev.join(' | '));
      resolve();
    });
  });
  await new Promise((resolve) => {
    const ev = [];
    const req = http.get({ host: '127.0.0.1', port: 1, agent: new http.Agent({ maxSockets: 1 }) });
    req.on('error', (e) => ev.push(`error ${e.code}`));
    req.on('close', () => {
      ev.push('close');
      console.log('refused:', ev.join(' | '));
      resolve();
    });
  });
  server.close();
});
