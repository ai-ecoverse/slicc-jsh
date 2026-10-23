const http = require('http');
const srv = http.createServer((req, res) => { let n = 0; req.on('data', (d) => (n += d.length)); req.on('end', () => res.end(String(n))); });
const row = (label, opts, act) => new Promise((resolve) => {
  const ev = [];
  const req = http.request({ host: '127.0.0.1', port: srv.address().port, method: 'POST', agent: false, ...opts }, (res) => {
    let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { ev.push(`response ${b}`); console.log(`${label} | ${ev.join(', ')}`); resolve(); });
  });
  req.on('drain', () => ev.push(`drain needDrain=${req.writableNeedDrain} length=${req.writableLength}`));
  req.on('socket', () => ev.push('socket'));
  act(req, ev);
});
srv.listen(0, '127.0.0.1', async () => {
  await row('4 MiB before connect, content-length', { headers: { 'Content-Length': 4 << 20 } }, (req, ev) => { ev.push(`write ${req.write(Buffer.alloc(4 << 20))} needDrain=${req.writableNeedDrain} length=${req.writableLength}`); req.once('drain', () => req.end()); });
  await row('16 KiB before connect', { headers: { 'Content-Length': 16384 } }, (req, ev) => { ev.push(`write ${req.write(Buffer.alloc(16384))} needDrain=${req.writableNeedDrain}`); req.once('drain', () => req.end()); });
  await row('16 KiB - 1 before connect', { headers: { 'Content-Length': 16383 + 1 } }, (req, ev) => { ev.push(`write ${req.write(Buffer.alloc(16383))} needDrain=${req.writableNeedDrain}`); ev.push(`write ${req.write('x')}`); req.end(); });
  await row('chunked, 64 KiB in four writes', {}, (req, ev) => { for (let i = 0; i < 4; i++) ev.push(`write ${req.write(Buffer.alloc(16384))}`); req.end(); });
  await row('a small write, then end', { headers: { 'Content-Length': 2 } }, (req, ev) => { ev.push(`write ${req.write('hi')}`); req.end(); });
  await row('highWaterMark 1024', { highWaterMark: 1024, headers: { 'Content-Length': 2048 } }, (req, ev) => { ev.push(`write ${req.write(Buffer.alloc(1024))} write ${req.write(Buffer.alloc(1024))}`); req.end(); });
  const one = (n, chunked) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, method: 'POST', agent: false, headers: chunked ? {} : { 'Content-Length': n } }, (res) => { res.resume(); res.on('end', resolve); });
    const r = req.write(Buffer.alloc(n));
    console.log(`${n} bytes, ${chunked ? 'chunked' : 'content-length'} | hwm`, req.writableHighWaterMark, 'header', req._header ? req._header.length : null, 'write', r, 'length', req.writableLength);
    req.end();
  });
  for (const n of [65449, 65450, 65451, 65536]) await one(n, false);
  for (const n of [65420, 65440, 65450]) await one(n, true);
  const preset = (label, opts, before) =>
    new Promise((resolve) => {
      const ev = [];
      const req = http.request({ host: '127.0.0.1', port: srv.address().port, method: 'POST', agent: false, ...opts }, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => {
          ev.push(`response ${b}`);
          console.log(`${label} | ${ev.join(', ')}`);
          resolve();
        });
      });
      req.on('drain', () => {
        ev.push(`drain length=${req.writableLength}`);
        req.end();
      });
      before?.(req);
      ev.push(`write ${req.write(Buffer.alloc(100000))} needDrain=${req.writableNeedDrain} length=${req.writableLength}`);
    });
  await preset('array headers', { headers: ['Content-Length', '100000', 'Host', 'x'] });
  await preset('_implicitHeader() before the first write', { headers: { 'Content-Length': '100000' } }, (req) => req._implicitHeader());
  srv.close();
});
