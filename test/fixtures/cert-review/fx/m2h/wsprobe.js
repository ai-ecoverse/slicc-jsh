const net = require('net');
const conns = [];
const srv = net.createServer((s) => {
  const c = { n: conns.length + 1, t: Date.now(), bytes: 0, head: '' }; conns.push(c);
  s.on('data', (d) => { c.bytes += d.length; if (!c.head) { c.head = d.toString('latin1').split('\r\n')[0]; c.firstMs = Date.now() - start; } if (/Upgrade: websocket/i.test(d.toString('latin1'))) s.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); });
  s.on('close', () => { c.closed = true; });
  s.on('error', () => {});
});
let start;
srv.listen(0, '127.0.0.1', () => {
  start = Date.now(); const ev = [];
  const w = new WebSocket(`ws://127.0.0.1:${srv.address().port}/x`);
  w.onerror = () => ev.push('error'); w.onclose = (e) => ev.push('close:' + e.code); w.onopen = () => ev.push('open');
  setTimeout(() => {
    console.log('server saw', conns.length, 'TCP connection(s):', conns.map((c) => `#${c.n} bytes=${c.bytes > 0 ? '>0' : 0} first=${JSON.stringify(c.head)} closed=${!!c.closed}`).join(' | '));
    console.log('client events after a 400 to the upgrade:', ev.join(',') || 'none', 'readyState', w.readyState);
    srv.close(); process.exit(0);
  }, 1500);
});
