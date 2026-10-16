const http = require('http'); const P = Number(process.env.LBPORT || 47915);
const srv = http.createServer((q, s) => s.end(`KERNEL ${q.headers.host}`));
srv.on('error', (e) => { console.log('listen', e.code); run(); });
srv.listen(P, '0.0.0.0', run);
let ran = false;
async function run() {
  if (ran) return; ran = true;
  for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '[::1]', '0.0.0.0', 'foo.localhost', `${P}.kernel.localhost`, 'host.slicc.internal']) {
    const u = h.endsWith('kernel.localhost') ? `http://${h}/` : `http://${h}:${P}/`;
    try { const r = await fetch(u, { signal: AbortSignal.timeout(8000) }); console.log(h, r.status, (await r.text()).slice(0, 60)); } catch (e) { console.log(h, 'ERR', e.name, e.message, e.cause?.code ?? e.cause?.message ?? ''); }
  }
  try { const r = await fetch('http://127.0.0.1:1/'); console.log('closed port', r.status); } catch (e) { console.log('closed port ERR', e.cause?.code ?? e.message); }
  srv.close(); setTimeout(() => process.exit(0), 100);
}
