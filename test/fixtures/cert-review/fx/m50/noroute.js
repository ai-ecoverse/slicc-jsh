const http = require('http');
const go = (l, opts, body) => new Promise((r) => { const q = http.request(opts, (res) => { let n = 0; res.on('data', (c) => (n += c.length)); res.on('end', () => { console.log(l, res.statusCode, res.headers['content-type'], n > 0, typeof res.headers.date); r(); }); }); q.on('error', (e) => { console.log(l, 'ERR', e.code, e.message); r(); }); q.setTimeout(15000, () => { console.log(l, 'timeout'); q.destroy(); }); if (body) q.write(body); q.end(); });
(async () => {
  await go('GET example.com', { host: 'example.com', path: '/', method: 'GET' });
  await go('HEAD example.com', { host: 'example.com', path: '/', method: 'HEAD' });
  await go('GET agent:false', { host: 'example.com', path: '/', agent: false });
  await go('GET url string', new URL('http://example.com/'));
  await new Promise((r) => http.get('http://example.com/', (res) => { console.log('http.get', res.statusCode, res.req?.method, res.req?.path); res.resume(); res.on('end', r); }).on('error', (e) => { console.log('http.get ERR', e.code); r(); }));
})();
