const net = require('net');
const http = require('http');
const row = (label, onConn, clientSide) => new Promise((resolve) => {
  const notes = [];
  let received = '';
  const srv = net.createServer((s) => {
    s.on('error', (e) => notes.push(`server error ${e.message}`));
    s.on('data', (d) => (received += d));
    s.on('close', () => notes.push('server close'));
    if (!clientSide) onConn(s, notes);
  });
  srv.listen(0, '127.0.0.1', () => {
    const c = net.connect(srv.address().port, '127.0.0.1');
    let got = '';
    c.on('connect', () => (clientSide ? onConn(c, notes) : c.write('hi')));
    c.on('data', (d) => (got += d));
    c.on('error', (e) => notes.push(`client error ${e.code}`));
    c.on('close', () => setTimeout(() => {
      console.log(`${label} | client got ${JSON.stringify(got)} | server got ${JSON.stringify(received)} | ${notes.join(', ')}`);
      srv.close(resolve);
    }, 50));
  });
});
(async () => {
  await row('write then destroy', (s) => s.once('data', () => { s.write('hello'); s.destroy(); }));
  await row('two writes then destroy', (s) => s.once('data', () => { s.write('a'); s.write('b'); s.destroy(); }));
  await row('write then destroy with an error', (s) => s.once('data', () => { s.write('hello'); s.destroy(new Error('x')); }));
  await row('end then destroy', (s) => s.once('data', () => { s.end('bye'); s.destroy(); }));
  await row('write, destroy on the next tick', (s) => s.once('data', () => { s.write('hello'); process.nextTick(() => s.destroy()); }));
  await row('corked write then destroy', (s) => s.once('data', () => { s.cork(); s.write('hello'); s.destroy(); }));
  await row('a client writes then destroys', (c) => { c.write('hello'); c.destroy(); }, true);
  await row('a client writes twice then destroys', (c) => { c.write('a'); c.write('b'); c.destroy(); }, true);
  await row('write callback after destroy', (s, notes) => s.once('data', () => { s.write('hello', (e) => notes.push(`write callback ${e ? e.code : 'ok'}`)); s.destroy(); }));
  await row('two write callbacks after destroy', (s, notes) => s.once('data', () => { s.write('a', (e) => notes.push(`a ${e ? e.code : 'ok'}`)); s.write('b', (e) => notes.push(`b ${e ? e.code : 'ok'}`)); s.destroy(); }));
  await new Promise((resolve) => {
    const srv = http.createServer((req, res) => res.end('ok'));
    srv.on('clientError', (e, s) => s.destroy());
    srv.listen(0, '127.0.0.1', () => {
      const c = net.connect(srv.address().port, '127.0.0.1');
      let got = '';
      c.on('connect', () => c.end('GET /a HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\nGET /b HTTP/1.1\r\nHost: x\r\n\r\n'));
      c.on('data', (d) => (got += d));
      c.on('close', () => { console.log(`an http response, then a clientError listener destroys | ${JSON.stringify(got.replace(/\r\nDate: [^\r\n]*/g, ''))}`); srv.close(resolve); });
    });
  });
  await new Promise((resolve) => {
    const srv = http.createServer((req, res) => { res.end('ok'); res.socket.destroy(); });
    srv.listen(0, '127.0.0.1', () => {
      const c = net.connect(srv.address().port, '127.0.0.1');
      let got = '';
      c.on('connect', () => c.write('GET /a HTTP/1.1\r\nHost: x\r\n\r\n'));
      c.on('data', (d) => (got += d));
      c.on('close', () => { console.log(`res.end then res.socket.destroy | ${JSON.stringify(got.replace(/\r\nDate: [^\r\n]*/g, ''))}`); srv.close(resolve); });
    });
  });
  console.log('done');
})();
