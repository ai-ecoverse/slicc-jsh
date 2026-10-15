const net = require('net');
const srv = net.createServer((s) => { s.on('end', () => { try { s.end('bye'); console.log('server end() in end handler ok'); } catch (e) { console.log('server threw', e.code, e.message); } }); s.on('close', () => { console.log('server close'); srv.close(); }); s.resume(); });
srv.listen(0, '127.0.0.1', () => { const c = net.connect(srv.address().port, '127.0.0.1', () => c.end('ping')); let d = ''; c.on('data', (x) => (d += x)); c.on('close', () => console.log('client got', JSON.stringify(d))); });
