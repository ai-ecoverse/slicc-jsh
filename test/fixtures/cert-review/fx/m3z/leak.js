const http = require('http');
const srv = http.createServer((q, s) => s.end('ok'));
const count = (a) => ['sockets', 'freeSockets', 'requests'].map((k) => `${k}=${Object.values(a[k] || {}).reduce((n, v) => n + v.length, 0)}/${Object.keys(a[k] || {}).length}`).join(' ');
srv.listen(0, '127.0.0.1', async () => {
  for (const [label, opts] of [['default', {}], ['keepAlive', { keepAlive: true }], ['keepAlive maxSockets 2', { keepAlive: true, maxSockets: 2 }]]) {
    const a = new http.Agent(opts); let conns = 0; const onConn = () => conns++; srv.on('connection', onConn);
    let maxActive = 0;
    await Promise.all(Array.from({ length: 100 }, (_, i) => new Promise((r) => http.get({ host: '127.0.0.1', port: srv.address().port, path: '/' + i, agent: a }, (res) => { maxActive = Math.max(maxActive, Object.values(a.sockets).reduce((n, v) => n + v.length, 0)); res.resume(); res.on('end', r); }).on('error', (e) => { console.log('err', e.code); r(); }))));
    const total = (k) => Object.values(a[k] || {}).reduce((n, v) => n + v.length, 0);
    const settled = () => total('sockets') === 0 && total('requests') === 0 && total('freeSockets') === (opts.keepAlive ? conns : 0);
    const until = Date.now() + 10000;
    while (!settled() && Date.now() < until) await new Promise((r) => setImmediate(r));
    srv.off('connection', onConn);
    console.log(`${label}: 100 requests, server connections ${conns > 2 ? (conns === 100 ? '100' : '>2') : conns}, max active sockets ${maxActive <= (opts.maxSockets ?? Infinity) ? 'within maxSockets' : maxActive}, after: ${count(a)}`);
    a.destroy();
    console.log(`${label} after destroy: ${count(a)}`);
  }
  srv.close();
});
