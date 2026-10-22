const http = require('http');
const https = require('https');

const seen = [];
const s = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    seen.push(`${req.method} ${req.url} ${JSON.stringify(req.rawHeaders)} ${JSON.stringify(body)}`);
    res.end('ok');
  });
});
const cases = [
  ['flat', 'GET', ['Host', 'example', 'x-a', '1', 'X-B', 'two']],
  ['pairs', 'GET', [['Host', 'example'], ['x-a', '1'], ['x-a', '2']]],
  ['keep-alive', 'GET', ['Host', 'example', 'x-c', '3']],
  ['with a length', 'POST', ['Host', 'example', 'Content-Length', '4']],
];
const tryIt = (label, fn) => {
  try {
    fn();
    console.log(label, 'ok');
  } catch (e) {
    console.log(label, e.code, e.message);
  }
};

s.listen(0, '127.0.0.1', async () => {
  const port = s.address().port;
  tryIt('odd', () => http.request({ host: '127.0.0.1', port, headers: ['a', '1', 'b'] }));
  tryIt('bad name', () => http.request({ host: '127.0.0.1', port, headers: ['a b', '1'] }));
  tryIt('undefined value', () => http.request({ host: '127.0.0.1', port, headers: [['a', undefined]] }));
  for (const [label, method, headers] of cases) {
    await new Promise((resolve) => {
      const agent = label === 'keep-alive' ? undefined : false;
      const r = http.request({ host: '127.0.0.1', port, method, path: '/' + label.replaceAll(' ', '-'), headers, agent }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      r.on('error', (e) => {
        console.log(label, 'error', e.code);
        resolve();
      });
      console.log(label, 'headersSent', r.headersSent, 'getHeaders', JSON.stringify(r.getHeaders()), JSON.stringify(r.getRawHeaderNames()), JSON.stringify(r._header));
      tryIt(`${label} setHeader`, () => r.setHeader('x-late', '1'));
      r.end(method === 'POST' ? 'body' : undefined);
    });
  }
  console.log(seen.join('\n'));
  const r = https.request('https://example.invalid/p', { headers: ['Host', 'example', 'x-s', '1'] });
  r.on('error', () => {});
  console.log('https', 'headersSent', r.headersSent, 'getHeaders', JSON.stringify(r.getHeaders()), JSON.stringify(r._header));
  r.destroy();
  http.globalAgent.destroy();
  s.close();
});
