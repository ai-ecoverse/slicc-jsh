const http = require('http'); const t0 = Date.now(); const ms = () => Math.round((Date.now() - t0) / 500) * 500;
const s = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/plain' }); r.write('first-chunk'); setTimeout(() => r.end('-end'), 3000); });
s.listen(0, '127.0.0.1', async () => {
  const u = `http://127.0.0.1:${s.address().port}/`;
  const r = await fetch(u); console.log('headers at ~', ms());
  const rd = r.body.getReader(); const a = await rd.read(); console.log('first chunk at ~', ms(), new TextDecoder().decode(a.value));
  const ac = new AbortController(); const r2 = await fetch(u, { signal: ac.signal }); const rd2 = r2.body.getReader(); await rd2.read();
  setTimeout(() => ac.abort(new Error('my-reason')), 200);
  try { for (;;) { const x = await rd2.read(); if (x.done) { console.log('second body ended without abort at ~', ms()); break; } } } catch (e) { console.log('abort during body', e.name, e.message, 'at ~', ms()); }
  s.close(); setTimeout(() => process.exit(0), 50);
});
