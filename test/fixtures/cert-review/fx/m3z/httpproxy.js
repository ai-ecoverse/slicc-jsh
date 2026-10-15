const http = require('http'), net = require('net');
const { HttpProxyAgent } = require('http-proxy-agent');
let proxied = [];
const origin = http.createServer((q, s) => s.end('origin saw ' + q.url));
const proxy = http.createServer((q, s) => { proxied.push(q.url); const u = new URL(q.url); const up = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: q.method, headers: q.headers }, (r) => { s.writeHead(r.statusCode, r.headers); r.pipe(s); }); q.pipe(up); });
origin.listen(0, '127.0.0.1', () => proxy.listen(0, '127.0.0.1', () => {
  const agent = new HttpProxyAgent(`http://127.0.0.1:${proxy.address().port}`);
  http.get(`http://127.0.0.1:${origin.address().port}/hello`, { agent }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { console.log(res.statusCode, b, '| proxy saw', proxied.map((u) => u.replace(/:\d+/, ':P')).join(',')); origin.close(); proxy.close(); });
  }).on('error', (e) => { console.log('error', e.code, e.message); origin.close(); proxy.close(); });
}));
