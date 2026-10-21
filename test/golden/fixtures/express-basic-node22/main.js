const http = require('http');
const path = require('path');
const express = require('express');

const app = express();
const seen = [];
app.use((req, res, next) => {
  seen.push(`${req.method} ${req.path}`);
  res.set('X-Chain', 'one');
  next();
});
app.use((req, res, next) => {
  res.append('X-Chain', 'two');
  next();
});
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.send('home'));
app.get('/users/:id', (req, res) => {
  res.json({ id: req.params.id, query: req.query, classes: [req instanceof http.IncomingMessage, res instanceof http.ServerResponse, res instanceof http.OutgoingMessage] });
});
app.post('/echo', (req, res) => {
  res.status(201).json({ got: req.body, type: req.get('content-type'), isJson: req.is('json') });
});
app.get('/text', (req, res) => res.status(202).type('text').send('plain text'));
app.get('/html', (req, res) => res.send('<p>html</p>'));
app.get('/buffer', (req, res) => res.send(Buffer.from('bytes')));
app.get('/old', (req, res) => res.redirect('/users/7?from=old'));
app.get('/moved', (req, res) => res.redirect(301, '/'));
app.get('/boom', () => {
  throw new Error('boom');
});
app.get('/async-boom', async () => {
  throw new Error('async boom');
});
app.get('/next-err', (req, res, next) => next(Object.assign(new Error('teapot'), { status: 418 })));
app.get('/stream', (req, res) => {
  res.type('text');
  res.write('a;');
  res.write('b;');
  res.end('c');
});
app.get('/end', (req, res) => res.sendStatus(204));
app.head('/head', (req, res) => res.set('X-Head', 'yes').send('not sent'));

app.use((req, res) => res.status(404).json({ missing: req.originalUrl }));
app.use((err, req, res, next) => {
  void next;
  res.status(err.status ?? 500).json({ error: err.type ?? err.message });
});

const show = ['content-type', 'content-length', 'location', 'x-chain', 'x-head', 'transfer-encoding', 'x-powered-by'];

function call(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const headers = body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        const picked = show.filter((h) => res.headers[h] !== undefined).map((h) => `${h}=${res.headers[h]}`);
        console.log(`${method} ${url} -> ${res.statusCode} ${res.statusMessage}`);
        console.log(`  ${picked.join(' | ')}`);
        console.log(`  body: ${JSON.stringify(data)}`);
        resolve();
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const server = app.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  await call(port, 'GET', '/');
  await call(port, 'GET', '/users/42?sort=desc&tags=a&tags=b');
  await call(port, 'POST', '/echo', JSON.stringify({ name: 'jsh', list: [1, 2, 3] }));
  await call(port, 'POST', '/echo', '{bad json');
  await call(port, 'GET', '/text');
  await call(port, 'GET', '/html');
  await call(port, 'GET', '/buffer');
  await call(port, 'GET', '/old');
  await call(port, 'GET', '/moved');
  await call(port, 'GET', '/boom');
  await call(port, 'GET', '/async-boom');
  await call(port, 'GET', '/next-err');
  await call(port, 'GET', '/stream');
  await call(port, 'GET', '/end');
  await call(port, 'HEAD', '/head');
  await call(port, 'GET', '/static/hello.txt');
  await call(port, 'GET', '/static/nope.txt');
  await call(port, 'GET', '/nowhere?x=1');
  console.log('seen', seen.join(', '));
  server.close(() => console.log('closed'));
});
