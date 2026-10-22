const http = require('http');
const net = require('net');

const NEXT = 'GET /next HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n';
const line = (start, headers = 'Host: x', body = '') => `${start}\r\n${headers}\r\n\r\n${body}`;

const cases = [
  ['a plain request stays open for the next one', line('GET /a HTTP/1.1') + NEXT],
  ['connection close does not take the next request', line('GET /a HTTP/1.1', 'Host: x\r\nConnection: close') + NEXT],
  ['lf-only request line', 'GET /a HTTP/1.1\nHost: x\r\n\r\n' + NEXT],
  ['lf-only header line', 'GET /a HTTP/1.1\r\nHost: x\n\r\n' + NEXT],
  ['lf-only end of headers', 'GET /a HTTP/1.1\r\nHost: x\r\n\n' + NEXT],
  ['lf-only throughout', 'GET /lf HTTP/1.1\nHost: x\n\n' + NEXT],
  ['a bare CR in a header', 'GET /a HTTP/1.1\r\nHost: x\rX\r\n\r\n' + NEXT],
  ['a bare CR in the request line', 'GET /a HTTP/1.1\rHost: x\r\n\r\n' + NEXT],
  ['obs-fold with a space', line('GET /a HTTP/1.1', 'Host: x\r\nX-A: one\r\n two') + NEXT],
  ['obs-fold with a tab', line('GET /a HTTP/1.1', 'Host: x\r\nX-A: one\r\n\ttwo') + NEXT],
  ['a space in a header name', line('GET /a HTTP/1.1', 'Host: x\r\nBad Name: y') + NEXT],
  ['a tab in a header name', line('GET /a HTTP/1.1', 'Host: x\r\nBad\tName: y') + NEXT],
  ['a control character in a header value', line('GET /a HTTP/1.1', 'Host: x\r\nX-A: a\x01b') + NEXT],
  ['a delete in a header value', line('GET /a HTTP/1.1', 'Host: x\r\nX-A: a\x7fb') + NEXT],
  ['a high byte in a header value', line('GET /a HTTP/1.1', 'Host: x\r\nX-A: a\x80b') + NEXT],
  ['a tab in a header value', line('GET /a HTTP/1.1', 'Host: x\r\nX-A: a\tb') + NEXT],
  ['an empty header name', line('GET /a HTTP/1.1', 'Host: x\r\n: value') + NEXT],
  ['a quoted header name', line('GET /a HTTP/1.1', 'Host: x\r\n"X-A": y') + NEXT],
  ['duplicate content-length, same digits', line('POST /a HTTP/1.1', 'Host: x\r\nContent-Length: 0\r\nContent-Length: 0') + NEXT],
  ['duplicate content-length, different digits', line('POST /a HTTP/1.1', 'Host: x\r\nContent-Length: 0\r\nContent-Length: 1') + NEXT],
  ['duplicate content-length, different case', line('POST /a HTTP/1.1', 'Host: x\r\nContent-Length: 0\r\ncontent-length: 0') + NEXT],
  ['content-length with a trailing space', line('POST /a HTTP/1.1', 'Host: x\r\nContent-Length: 0 ') + NEXT],
  ['content-length with a leading space', line('POST /a HTTP/1.1', 'Host: x\r\nContent-Length:  0') + NEXT],
  ['content-length with a tab', line('POST /a HTTP/1.1', 'Host: x\r\nContent-Length:\t0') + NEXT],
  ['content-length with a comma', line('POST /a HTTP/1.1', 'Host: x\r\nContent-Length: 0, 0') + NEXT],
  ['content-length plus five', line('POST /a HTTP/1.1', 'Host: x\r\nContent-Length: +5', 'hello') + NEXT],
  ['transfer-encoding chunked in upper case', line('POST /a HTTP/1.1', 'Host: x\r\nTransfer-Encoding: Chunked', '5\r\nhello\r\n0\r\n\r\n') + NEXT],
  ['transfer-encoding chunked with a trailing space', line('POST /a HTTP/1.1', 'Host: x\r\nTransfer-Encoding: chunked ', '0\r\n\r\n') + NEXT],
  ['transfer-encoding with a trailing comma', line('POST /a HTTP/1.1', 'Host: x\r\nTransfer-Encoding: chunked,', '0\r\n\r\n') + NEXT],
  ['transfer-encoding with a leading comma', line('POST /a HTTP/1.1', 'Host: x\r\nTransfer-Encoding: ,chunked', '0\r\n\r\n') + NEXT],
  ['transfer-encoding chunked twice', line('POST /a HTTP/1.1', 'Host: x\r\nTransfer-Encoding: chunked, chunked', '0\r\n\r\n') + NEXT],
  ['transfer-encoding gzip then chunked, mixed case', line('POST /a HTTP/1.1', 'Host: x\r\nTransfer-Encoding: gzip, Chunked', '0\r\n\r\n') + NEXT],
  ['transfer-encoding chunked then gzip, mixed case', line('POST /a HTTP/1.1', 'Host: x\r\nTransfer-Encoding: CHUNKED, gzip', '0\r\n\r\n') + NEXT],
  ['transfer-encoding chunked and content-length, different case', line('POST /a HTTP/1.1', 'Host: x\r\ntransfer-encoding: chunked\r\nContent-Length: 0', '0\r\n\r\n') + NEXT],
  ['content-length and transfer-encoding, whitespace', line('POST /a HTTP/1.1', 'Host: x\r\nContent-Length: 0\r\nTransfer-Encoding: chunked ', '0\r\n\r\n') + NEXT],
  ['two transfer-encoding headers', line('POST /a HTTP/1.1', 'Host: x\r\nTransfer-Encoding: gzip\r\nTransfer-Encoding: chunked', '0\r\n\r\n') + NEXT],
  ['a blank transfer-encoding before content-length', line('POST /a HTTP/1.1', 'Host: x\r\nTransfer-Encoding: \r\nContent-Length: 0') + NEXT],
  ['a blank transfer-encoding after content-length', line('POST /a HTTP/1.1', 'Host: x\r\nContent-Length: 0\r\nTransfer-Encoding:') + NEXT],
  ['a lower-case method', 'get /a HTTP/1.1\r\nHost: x\r\n\r\n' + NEXT],
  ['a tab after the method', 'GET\t/a HTTP/1.1\r\nHost: x\r\n\r\n' + NEXT],
  ['two spaces before the target', line('GET  /a HTTP/1.1') + NEXT],
  ['two spaces before the version', line('GET /a  HTTP/1.1') + NEXT],
  ['a trailing space after the version', 'GET /a HTTP/1.1 \r\nHost: x\r\n\r\n' + NEXT],
  ['HTTP/1.10', line('GET /a HTTP/1.10') + NEXT],
  ['HTTP/2.0', line('GET /a HTTP/2.0') + NEXT],
  ['an unknown method', line('FOO /a HTTP/1.1') + NEXT],
  ['asterisk is a path', line('GET *foo HTTP/1.1') + NEXT],
  ['OPTIONS asterisk', line('OPTIONS * HTTP/1.1') + NEXT],
  ['an absolute URL', line('GET http://x/a HTTP/1.1') + NEXT],
  ['HTTP/0.9', 'GET /old\r\n' + NEXT],
  ['HTTP/1.0 with an explicit pipeline', 'GET /a HTTP/1.0\r\nHost: x\r\n\r\n' + NEXT],
  ['HTTP/1.0 keep-alive stays open', line('GET /a HTTP/1.0', 'Host: x\r\nConnection: keep-alive') + NEXT],
];

const shot = (label, bytes) =>
  new Promise((resolve) => {
    const requests = [];
    const errors = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        requests.push(`${req.method} ${req.url} HTTP/${req.httpVersion} ${JSON.stringify(body)}`);
        res.end('ok');
      });
    });
    srv.on('clientError', (err, socket) => {
      errors.push(err.code);
      socket.destroy();
    });
    srv.listen(0, '127.0.0.1', () => {
      const c = net.connect(srv.address().port, '127.0.0.1');
      let got = '';
      c.on('connect', () => c.end(Buffer.from(bytes, 'latin1')));
      c.on('data', (d) => (got += d));
      c.on('error', () => {});
      c.on('close', () => {
        setTimeout(() => {
          const status = got
            .split('\r\n')
            .filter((row) => /^HTTP\/1\./.test(row))
            .map((row) => row.split(' ')[1])
            .join(',') || '-';
          const seen = requests.join(' || ') || '-';
          const next = requests.some((row) => row.startsWith('GET /next '));
          console.log(`${label} | status ${status} | requests ${seen} | errors ${errors.join(',') || '-'} | next ${next ? 'yes' : 'no'}`);
          srv.close(() => resolve());
        }, 20);
      });
    });
  });

(async () => {
  for (const [label, bytes] of cases) await shot(label, bytes);
  console.log('closed');
})();
