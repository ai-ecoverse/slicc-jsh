const http = require('http'), crypto = require('crypto'); const t0 = Date.now(); const ms = () => Math.round((Date.now() - t0) / 500) * 500;
const frame = (s, op = 1) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from([0x80 | op, b.length]), b]); };
const s = require('net').createServer((sock) => {
  let buf = Buffer.alloc(0), up = false;
  sock.on('data', (d) => {
    if (!up) {
      buf = Buffer.concat([buf, d]); const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
      const lines = buf.subarray(0, i).toString().split('\r\n'); const hd = Object.fromEntries(lines.slice(1).map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
      if (lines[0].includes('/deny')) { sock.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
      const acc = crypto.createHash('sha1').update(hd['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      const proto = hd['sec-websocket-protocol']?.split(',')[0].trim();
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n${proto ? `Sec-WebSocket-Protocol: ${proto}\r\n` : ''}\r\n`);
      sock.write(frame('hello-from-server')); up = true; return;
    }
    const op = d[0] & 15, len = d[1] & 127, mask = d.subarray(2, 6), p = Buffer.from(d.subarray(6, 6 + len)).map((x, i) => x ^ mask[i % 4]);
    if (op === 8) { sock.write(Buffer.concat([Buffer.from([0x88, p.length]), p])); sock.end(); return; }
    sock.write(frame(`echo:${p.toString()}`));
  });
  sock.on('error', () => {});
});
s.listen(0, '127.0.0.1', () => {
  const port = s.address().port;
  console.log('typeof WebSocket', typeof WebSocket);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/x`, ['chat', 'other']);
  const got = [];
  ws.onopen = () => { console.log('open', ws.readyState, ws.protocol, ws.url.replace(/:\d+/, ':P')); ws.send('ping1'); };
  ws.onmessage = (e) => { got.push(e.data); if (got.length === 2) ws.close(1000, 'bye'); };
  ws.onclose = (e) => {
    console.log('messages', JSON.stringify(got), 'close', e.code, e.reason, e.wasClean);
    let done = false; const next = () => { if (done) return; done = true; const w3 = new WebSocket(`ws://127.0.0.1:1/`); let f3 = false; const fin = (l) => { if (f3) return; f3 = true; console.log(l); try { new WebSocket('ftp://x/'); } catch (er) { console.log('bad scheme', er.name); } s.close(); setTimeout(() => process.exit(0), 50); }; w3.onerror = () => console.log('port1 error'); w3.onclose = (e) => fin(`port1 close ${e.code}`); setTimeout(() => fin('port1 no close in 3s'), 3000); };
    const w2 = new WebSocket(`ws://127.0.0.1:${port}/deny`);
    w2.onerror = (e) => console.log('deny error event', e.type);
    w2.onclose = (e) => { console.log('deny close', e.code); next(); };
    setTimeout(() => { if (!done) console.log('deny no close in 3s'); next(); }, 3000);
  };
});
