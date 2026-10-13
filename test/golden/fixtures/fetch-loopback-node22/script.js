// fetch() to a server of this program on the loopback, against host Node
// (undici): what the server sees, and the Response. (The server's framing,
// content-length or chunked, is node:http's own; it isn't compared here.)
const http = require('http');
const zlib = require('zlib');
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const u = req.url;
    if (u === '/redirect') { res.writeHead(302, { location: '/final' }); return res.end(); }
    if (u === '/see-other') { res.writeHead(303, { location: '/echo' }); return res.end(); }
    if (u === '/temp') { res.writeHead(307, { location: '/echo' }); return res.end(); }
    if (u.startsWith('/to?')) { res.writeHead(302, { location: decodeURIComponent(u.slice(4)) }); return res.end(); }
    if (u === '/final') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('final'); }
    if (u === '/gzip') { res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' }); return res.end(zlib.gzipSync('zipped body')); }
    if (u === '/deflate') { res.writeHead(200, { 'content-encoding': 'deflate' }); return res.end(zlib.deflateSync('deflated body')); }
    if (u === '/empty') { res.writeHead(204); return res.end(); }
    if (u === '/chunks') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('one,'); setTimeout(() => res.end('two'), 10); return; }
    if (u === '/json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"k":[1,2]}'); }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection'].includes(k)));
    res.writeHead(201, 'Made', { 'x-multi': ['a', 'b'], 'content-type': 'application/json' });
    res.end(JSON.stringify({ method: req.method, url: u, headers, body }));
  });
});
srv.listen(0, '127.0.0.1', async () => {
  const { port } = srv.address();
  const base = `http://127.0.0.1:${port}`;
  const show = async (l, p, read = (r) => r.text()) => {
    try {
      const r = await p;
      console.log(l, r.status, JSON.stringify(r.statusText), JSON.stringify([...r.headers].filter(([k]) => !['date', 'connection', 'keep-alive', 'transfer-encoding', 'content-length'].includes(k))), r.redirected, r.url.replace(/:\d+\//, ':PORT/'), r.ok, JSON.stringify(await read(r)));
    } catch (e) {
      console.log(l, 'THROWS', e.name, e.message, e.cause && (e.cause.code || e.cause.message));
    }
  };
  await show('get', fetch(`${base}/a?b=1`));
  await show('localhost', fetch(`http://localhost:${port}/l`));
  await show('post json', fetch(`${base}/p`, { method: 'POST', body: JSON.stringify({ x: 1 }), headers: { 'content-type': 'application/json', 'x-h': 'v' } }));
  await show('post params', fetch(`${base}/q`, { method: 'POST', body: new URLSearchParams({ a: '1' }) }));
  await show('post empty', fetch(`${base}/e`, { method: 'POST' }));
  await show('put bytes', fetch(`${base}/b`, { method: 'PUT', body: new Uint8Array([104, 105]) }));
  await show('a Request', fetch(new Request(`${base}/r`, { method: 'DELETE', headers: { 'x-req': '1' } })));
  await show('user-agent set', fetch(`${base}/ua`, { headers: { 'user-agent': 'me', accept: 'text/plain' } }));
  await show('redirect', fetch(`${base}/redirect`));
  await show('303 after POST', fetch(`${base}/see-other`, { method: 'POST', body: 'x' }));
  await show('307 after POST', fetch(`${base}/temp`, { method: 'POST', body: 'kept' }));
  await show('redirect manual', fetch(`${base}/redirect`, { redirect: 'manual' }));
  await show('redirect error', fetch(`${base}/redirect`, { redirect: 'error' }));
  await show('gzip', fetch(`${base}/gzip`));
  await show('deflate', fetch(`${base}/deflate`));
  await show('204', fetch(`${base}/empty`));
  await show('HEAD', fetch(`${base}/final`, { method: 'HEAD' }));
  await show('chunks', fetch(`${base}/chunks`));
  await show('json', fetch(`${base}/json`), (r) => r.json());
  await show('a body stream', fetch(`${base}/chunks`), async (r) => { const parts = []; const reader = r.body.getReader(); for (;;) { const { value, done } = await reader.read(); if (done) return parts.join(''); parts.push(new TextDecoder().decode(value)); } });
  const ac = new AbortController();
  ac.abort();
  await show('aborted', fetch(`${base}/x`, { signal: ac.signal }));
  const ac2 = new AbortController();
  const p = fetch(`${base}/chunks`, { signal: ac2.signal });
  ac2.abort();
  await show('aborted in flight', p);
  const ac3 = new AbortController();
  await show('aborted while the body is read', fetch(`${base}/chunks`, { signal: ac3.signal }), (r) => { const t = r.text(); ac3.abort(); return t; });
  // A redirect to another origin (another port) drops the credentials.
  await new Promise((resolve) => {
    const far = http.createServer((req, res) => {
      res.end(JSON.stringify(Object.keys(req.headers).filter((k) => k !== 'connection')));
    }).listen(0, '127.0.0.1', async () => {
      const farUrl = `http://localhost:${far.address().port}/far`;
      await show('cross-origin redirect', fetch(`${base}/to?${encodeURIComponent(farUrl)}`, { headers: { authorization: 'Bearer s', cookie: 'c=1', 'proxy-authorization': 'p', 'x-keep': '1' } }), async (r) => (await r.text()));
      await show('same-origin redirect', fetch(`${base}/to?${encodeURIComponent(`${base}/echo`)}`, { headers: { authorization: 'Bearer s', cookie: 'c=1' } }), async (r) => JSON.parse(await r.text()).headers);
      far.close(resolve);
    });
  });
  srv.close();
  const other = http.createServer().listen(0, '127.0.0.1', () => {
    const free = other.address().port;
    other.close(async () => {
      await show('refused', fetch(`http://127.0.0.1:${free}/x`));
      await show('refused, again', fetch(`http://127.0.0.1:${free}/y`));
    });
  });
});
