const http = require('http'), net = require('net'), crypto = require('crypto');
const s = http.createServer((q, r) => r.end('plain'));
s.on('upgrade', (q, sock, head) => { console.log('server upgrade event', q.url, q.headers.upgrade, typeof sock.write); const acc = crypto.createHash('sha1').update(q.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'); sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`); sock.write(Buffer.from([0x81, 2, 0x68, 0x69])); });
s.listen(0, '127.0.0.1', () => {
  const port = s.address().port;
  const c = net.connect(port, '127.0.0.1', () => c.write(`GET /raw HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  let b = Buffer.alloc(0); c.on('data', (d) => { b = Buffer.concat([b, d]); });
  setTimeout(() => {
    console.log('raw reply', JSON.stringify(b.toString('latin1').split('\r\n')[0]), b.length > 0); c.destroy();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/x`);
    ws.onopen = () => console.log('ws open'); ws.onerror = (e) => console.log('ws error', e.message ?? e.type); ws.onclose = (e) => console.log('ws close', e.code);
    ws.onmessage = (e) => { console.log('ws msg', e.data); ws.close(); };
    setTimeout(() => { console.log('ws state', ws.readyState); s.close(); process.exit(0); }, 4000);
  }, 1000);
});
