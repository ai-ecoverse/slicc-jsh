const http = require('http');
const net = require('net');

const head = 'GET /a HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n';
const old = 'GET /a HTTP/1.0\r\n\r\n';

const shot = (label, packets, { listener = false } = {}) =>
  new Promise((resolve) => {
    const log = [];
    const total = packets.reduce((n, p) => n + p.length, 0);
    const srv = http.createServer((req, res) => {
      log.push(`request ${req.url}`);
      req.resume();
      req.on('end', () => log.push(`end ${req.url}`));
      res.on('finish', () => log.push('finish'));
      const start = Date.now();
      const poll = () => {
        if (req.socket.destroyed) return;
        if (req.socket.bytesRead < total && Date.now() - start < 5000) return setTimeout(poll, 10);
        setTimeout(() => res.end('ok'), 10);
      };
      poll();
    });
    if (listener) {
      srv.on('clientError', (e, s) => {
        log.push(`clientError ${e.code}`);
        s.destroy();
      });
    }
    srv.listen(0, '127.0.0.1', () => {
      const c = net.connect(srv.address().port, '127.0.0.1');
      let got = '';
      c.on('data', (d) => (got += d));
      const queue = [...packets];
      const send = () => {
        if (queue.length) c.write(queue.shift(), () => setTimeout(send, 20));
      };
      c.on('connect', send);
      const bound = setTimeout(() => {
        log.push('still open');
        c.destroy();
      }, 8000);
      c.on('close', () => {
        clearTimeout(bound);
        console.log(`${label}\n  ${log.join(', ')}\n  ${JSON.stringify(got.replace(/Date: [^\r]*\r\n/, ''))}`);
        srv.close(resolve);
      });
    });
  });

(async () => {
  await shot('a CRLF in a later packet', [head, '\r\n']);
  await shot('a LF, then a CRLF, in later packets', [head, '\n', '\r\n']);
  await shot('a CRLF after an HTTP/1.0 request', [old, '\r\n']);
  await shot('CRLFs in the same packet', [head + '\r\n\r\n']);
  await shot('a CRLF, then a request, in a later packet', [head, '\r\nGET /b HTTP/1.1\r\nHost: x\r\n\r\n']);
  await shot('a CRLF, then a request, in a later packet, with a clientError listener', [head, '\r\nGET /b HTTP/1.1\r\nHost: x\r\n\r\n'], { listener: true });
  await shot('a CRLF in a later packet, then a byte in the next', [head, '\r\n', 'x']);
  await shot('a CRLF and a byte in the same packet', [head + '\r\nx']);
})();
