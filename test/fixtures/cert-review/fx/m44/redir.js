const http = require('http');
const listen = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r(s)); });
(async () => {
  const B = await listen((q, s) => { s.setHeader('content-type', 'application/json'); s.end(JSON.stringify({ path: q.url, auth: q.headers.authorization ?? null, pauth: q.headers['proxy-authorization'] ?? null, cookie: q.headers.cookie ?? null, x: q.headers['x-keep'] ?? null, cl: q.headers['content-length'] ?? null, te: q.headers['transfer-encoding'] ?? null, method: q.method })); });
  const pb = B.address().port;
  const A = await listen((q, s) => {
    if (q.url === '/cross') { s.writeHead(302, { location: `http://localhost:${pb}/landed` }); return s.end(); }
    if (q.url === '/same') { s.writeHead(302, { location: '/echo' }); return s.end(); }
    if (q.url === '/echo') { s.setHeader('content-type', 'application/json'); return s.end(JSON.stringify({ path: q.url, auth: q.headers.authorization ?? null, cookie: q.headers.cookie ?? null, cl: q.headers['content-length'] ?? null })); }
    if (q.url === '/slow') { s.write('first-chunk'); const t = setInterval(() => s.write('.'), 100); q.on('close', () => clearInterval(t)); return; }
    s.end('A');
  });
  const pa = A.address().port;
  const H = { authorization: 'Bearer SECRET', 'proxy-authorization': 'Basic PSECRET', cookie: 'c=COOKIE', 'x-keep': 'kept' };
  const show = async (l, p) => { try { const r = await p; console.log(l, r.status, r.redirected, new URL(r.url).pathname, await r.text()); } catch (e) { console.log(l, 'ERR', e.name, e.message, e.cause?.code ?? ''); } };
  await show('cross-origin redirect', fetch(`http://127.0.0.1:${pa}/cross`, { headers: H }));
  await show('same-origin redirect', fetch(`http://127.0.0.1:${pa}/same`, { headers: H }));
  await show('bodiless GET', fetch(`http://127.0.0.1:${pb}/get`));
  await show('HEAD', fetch(`http://127.0.0.1:${pb}/head`, { method: 'HEAD' }));
  await show('POST body', fetch(`http://127.0.0.1:${pb}/post`, { method: 'POST', body: 'abc' }));
  await show('redirect manual', fetch(`http://127.0.0.1:${pa}/cross`, { redirect: 'manual' }));
  await show('redirect error', fetch(`http://127.0.0.1:${pa}/cross`, { redirect: 'error' }));
  const ac = new AbortController();
  try {
    const r = await fetch(`http://127.0.0.1:${pa}/slow`, { signal: ac.signal });
    const rd = r.body.getReader(); const first = await rd.read(); console.log('slow first chunk', new TextDecoder().decode(first.value).slice(0, 11));
    setTimeout(() => ac.abort(new Error('my-reason')), 150);
    for (;;) { const x = await rd.read(); if (x.done) { console.log('slow body done?'); break; } }
  } catch (e) { console.log('abort during body', e.name, e.message); }
  const ac2 = new AbortController(); ac2.abort();
  try { await fetch(`http://127.0.0.1:${pa}/`, { signal: ac2.signal }); } catch (e) { console.log('pre-aborted', e.name); }
  A.close(); B.close();
  setTimeout(() => process.exit(0), 100);
})();
