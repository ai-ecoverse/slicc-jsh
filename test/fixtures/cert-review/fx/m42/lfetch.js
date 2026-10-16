const http = require('http'), net = require('net');
const T = async (l, f) => { try { console.log(l, await f()); } catch (e) { console.log(l, 'ERR', e.name, e.message, e.cause ? `cause=${e.cause.code ?? ''} ${e.cause.message ?? e.cause}` : ''); } };
const srv = http.createServer((q, s) => { s.setHeader('content-type', 'text/plain'); s.end(`hello ${q.method} ${q.url}`); });
srv.listen(0, '127.0.0.1', async () => {
  const p = srv.address().port;
  await T('http.get 127.0.0.1', () => new Promise((res, rej) => http.get(`http://127.0.0.1:${p}/a`, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(`${r.statusCode} ${b}`)); }).on('error', rej)));
  await T('net.connect 127.0.0.1', () => new Promise((res, rej) => { const c = net.connect(p, '127.0.0.1', () => { c.write('GET /n HTTP/1.0\r\n\r\n'); }); let b = ''; c.on('data', (d) => (b += d)); c.on('end', () => res(b.split('\r\n')[0])); c.on('error', rej); }));
  await T('fetch 127.0.0.1', async () => { const r = await fetch(`http://127.0.0.1:${p}/f`); return `${r.status} ${await r.text()}`; });
  await T('fetch localhost', async () => { const r = await fetch(`http://localhost:${p}/f2`); return `${r.status} ${await r.text()}`; });
  await T('fetch POST 127.0.0.1', async () => { const r = await fetch(`http://127.0.0.1:${p}/p`, { method: 'POST', body: 'x' }); return `${r.status} ${await r.text()}`; });
  if (process.env.EXT_PORT) {
    await T('fetch kernel 9222-style listener', async () => { const r = await fetch(`http://127.0.0.1:${process.env.EXT_PORT}/json/version`); return `${r.status} ${(await r.text()).slice(0, 60)}`; });
  }
  await T('fetch closed port', async () => { const r = await fetch('http://127.0.0.1:1/'); return r.status; });
  srv.close();
});
