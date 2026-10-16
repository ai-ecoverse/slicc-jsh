const http = require('http'); const t0 = Date.now(); const ms = () => Math.round((Date.now() - t0) / 500) * 500;
const srv = http.createServer((req, res) => res.end('ok' + req.url));
srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  const one = (label, opts) => new Promise((r) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/' + label, ...opts }, (res) => {
      console.log(label, 'response', res.statusCode, res.headers.connection, 'at ~', ms());
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { console.log(label, 'end', b, 'at ~', ms()); r(); });
    });
    req.on('error', (e) => { console.log(label, 'err', e.code); r(); });
    setTimeout(() => { console.log(label, 'stuck at 2s'); r(); }, 2000);
  });
  await one('plain', {});
  await one('agentfalse', { agent: false });
  await one('ka-header', { headers: { connection: 'keep-alive' } });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  await one('ka1', { agent }); await one('ka2', { agent });
  agent.destroy();
  const r = await fetch(`http://127.0.0.1:${port}/f`); console.log('fetch', r.status, await r.text());
  srv.close(); setTimeout(() => process.exit(0), 50);
});
