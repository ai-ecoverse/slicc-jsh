const http = require('http'); const t0 = Date.now(); const ms = () => Math.round((Date.now() - t0) / 500) * 500;
let n = 0;
const s = http.createServer((q, r) => {
  if (q.url === '/sse') { r.writeHead(200, { 'content-type': 'text/event-stream' }); r.flushHeaders(); const iv = setInterval(() => r.write(`data: ${n++}\n\n`), 300); r.on('close', () => clearInterval(iv)); return; }
  if (q.url === '/poll') { setTimeout(() => { r.writeHead(200); r.end('polled'); }, 1500); return; }
  if (q.url === '/hs') { r.write('a'); try { r.setHeader('x-late', '1'); } catch (e) { console.log('setHeader after write', e.code); } try { r.writeHead(201); } catch (e) { console.log('writeHead after write', e.code); } r.end('b'); return; }
  r.end('?');
});
s.listen(0, '127.0.0.1', async () => {
  const u = `http://127.0.0.1:${s.address().port}`;
  const r = await fetch(`${u}/sse`); console.log('sse headers at ~', ms(), r.status, r.headers.get('content-type'));
  const rd = r.body.getReader(); const td = new TextDecoder(); let got = '';
  while (!/data: 2/.test(got)) { const x = await rd.read(); got += td.decode(x.value); }
  console.log('sse three events at ~', ms(), JSON.stringify(got.split('\n\n').filter(Boolean).slice(0, 3)));
  await rd.cancel(); console.log('sse cancelled at ~', ms());
  const ac = new AbortController(); const r2 = await fetch(`${u}/sse`, { signal: ac.signal }); const rd2 = r2.body.getReader(); await rd2.read();
  setTimeout(() => ac.abort(new Error('my-reason')), 400);
  try { for (;;) { const x = await rd2.read(); if (x.done) { console.log('ended'); break; } } } catch (e) { console.log('abort during sse body', e.name, e.message, 'at ~', ms()); }
  const t1 = Date.now(); const p = await fetch(`${u}/poll`); console.log('poll', p.status, await p.text(), 'after ~', Math.round((Date.now() - t1) / 500) * 500);
  const h = await fetch(`${u}/hs`); console.log('hs', h.status, h.headers.get('x-late'), await h.text());
  s.closeAllConnections?.(); s.close(); setTimeout(() => process.exit(0), 50);
});
