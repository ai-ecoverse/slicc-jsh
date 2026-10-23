const http = require('http');
const net = require('net');
(async () => {
  {
    const log = [];
    const srv = http.createServer({ requestTimeout: 300, connectionsCheckingInterval: 50 }, (req) => {
      log.push('request');
      req.on('data', () => {});
      req.on('aborted', () => log.push('aborted'));
      req.on('error', (e) => log.push(`req error ${e.code}`));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    await new Promise((resolve) => {
      const c = net.connect(srv.address().port, '127.0.0.1');
      let got = '';
      c.on('data', (d) => (got += d));
      c.on('close', () => {
        console.log('requestTimeout with the body still coming:', JSON.stringify(got.split('\r\n')[0]), got.includes('Connection: close'));
        resolve();
      });
      c.write('POST /up HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\nabc');
    });
    await new Promise((r) => setImmediate(r));
    console.log('server:', log.join(', '));
    srv.close();
  }
  {
    const SIZE = 4 << 20;
    let read;
    const reading = new Promise((resolve) => (read = resolve));
    const srv = http.createServer((req, res) => {
      reading.then(() => {
        console.log('a handler that waits: the socket has read less than the upload', req.socket.bytesRead < SIZE);
        let got = 0;
        req.on('data', (d) => (got += d.length));
        req.on('end', () => {
          console.log('read on: every byte', got === SIZE);
          res.end('ok');
        });
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: srv.address().port, method: 'POST', agent: false, headers: { 'Content-Length': SIZE } }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.write(Buffer.alloc(SIZE, 1));
      req.end();
      setTimeout(read, 300);
    });
    srv.close();
  }
})();
