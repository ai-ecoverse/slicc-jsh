const net = require('net');
const tls = require('tls');
const log = (...a) => console.log(...a);
const closeOf = (label, s) => new Promise((resolve) => {
  s.on('error', (e) => log(label, 'error', label.startsWith('tls') ? '(the handshake failed)' : e.code ?? e.message));
  s.on('close', (...a) => { log(label, 'close', JSON.stringify(a)); resolve(); });
});
(async () => {
  await closeOf('refused', net.connect(1, '127.0.0.1'));
  const srv = net.createServer((s) => { s.on('error', () => {}); s.on('data', () => {}); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const connected = () => new Promise((resolve) => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => resolve(c)); });
  let c = await connected(); const a = closeOf('destroy()', c); c.destroy(); await a;
  c = await connected(); const b = closeOf('destroy(err)', c); c.destroy(new Error('boom')); await b;
  c = await connected(); const d = closeOf('end(), then destroy() once finished', c); c.end(); await new Promise((r) => c.once('finish', r)); c.destroy(); await d;
  const writeAfter = await connected(); const e = closeOf('destroy(err) while connecting', net.connect(port, '127.0.0.1').destroy(new Error('early'))); await e; writeAfter.destroy();
  const s2 = net.createServer((x) => x.end('nope\n'));
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  await closeOf('tls to a plain server', tls.connect(s2.address().port, '127.0.0.1', { rejectUnauthorized: false }));
  s2.close(); srv.close();
})();
