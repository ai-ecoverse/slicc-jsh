const http = require('http');
const net = require('net');

const order = (label, write) =>
  new Promise((resolve) => {
    const srv = net.createServer((s) => {
      s.resume();
      s.on('end', () => s.end());
    });
    srv.listen(0, '127.0.0.1', () => {
      const c = net.connect(srv.address().port, '127.0.0.1', () => {
        c.on('close', () => srv.close(resolve));
        const log = [];
        write(c, log);
        process.nextTick(() => log.push('tick'));
        setImmediate(() => log.push('immediate'));
        setTimeout(() => {
          console.log(`${label}: ${log.join(', ')}`);
          c.end();
        }, 50);
      });
    });
  });

const post = (url, body) => `POST ${url} HTTP/1.1\r\nHost: x\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
const pipelined = (label, handler) =>
  new Promise((resolve) => {
    const log = [];
    const srv = http.createServer((req, res) => {
      const url = req.url;
      log.push(`request ${url}`);
      req.on('data', (d) => log.push(`data ${d} ${url}`));
      req.on('end', () => log.push(`end ${url}`));
      res.on('finish', () => log.push(`finish ${url}`));
      res.on('close', () => log.push(`res close ${url}`));
      handler(req, res);
    });
    srv.listen(0, '127.0.0.1', () => {
      const c = net.connect(srv.address().port, '127.0.0.1');
      let got = '';
      c.on('connect', () => c.write(post('/a', 'foo') + post('/b', 'foo') + post('/c', 'foo')));
      c.on('data', (d) => {
        got += d;
        if ((got.match(/HTTP\/1\.1 200/g) || []).length === 3) c.end();
      });
      c.on('close', () =>
        setTimeout(() => {
          console.log(`${label}\n  ${log.join(', ')}`);
          srv.close(resolve);
        }, 50)
      );
    });
  });

(async () => {
  await order('a small write', (c, log) => c.write('x', () => log.push('callback')));
  await order('two small writes', (c, log) => {
    c.write('x', () => log.push('callback 1'));
    c.write('y', () => log.push('callback 2'));
  });
  await pipelined('pipelined posts answered at once', (req, res) => res.end('ok'));
  await pipelined('pipelined posts answered at their end', (req, res) => req.on('end', () => res.end('ok')));
})();
