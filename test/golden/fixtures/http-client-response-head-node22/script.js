const http = require('http');
const net = require('net');

const one = (label, wire, opts = {}) =>
  new Promise((resolve) => {
    const srv = net.createServer((s) => {
      let head = '';
      s.on('error', () => {});
      s.on('data', (d) => {
        head += d;
        if (!head.includes('\r\n\r\n')) return;
        const parts = Array.isArray(wire) ? wire : [wire];
        const next = () => {
          const part = parts.shift();
          if (parts.length === 0) s.end(part);
          else s.write(part, () => setTimeout(next, 20));
        };
        next();
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const ev = [];
      const req = http.get({ host: '127.0.0.1', port: srv.address().port, agent: false, ...opts }, (res) => {
        let body = '';
        ev.push(`response ${res.statusCode} ${JSON.stringify(res.statusMessage)} ${res.httpVersion}`);
        res.on('data', (d) => (body += d));
        res.on('end', () => ev.push(`end ${JSON.stringify(body)}${res.rawTrailers.length ? ` trailers ${JSON.stringify(res.rawTrailers)}` : ''}`));
        res.on('error', (e) => ev.push(`res error ${e.code}`));
      });
      req.on('error', (e) => ev.push(`error ${e.code} ${JSON.stringify(e.message)}`));
      req.on('close', () =>
        setTimeout(() => {
          console.log(`${label} | ${ev.join(', ')}`);
          srv.close(resolve);
        }, 30)
      );
    });
  });

const chunked = (line) => `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${line}\r\nhi\r\n0\r\n\r\n`;

const rows = [
  ['te chunked, gzip', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked, gzip\r\nConnection: close\r\n\r\nhi'],
  ['te gzip', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\nhi'],
  ['te gzip, chunked', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n2\r\nhi\r\n0\r\n\r\n'],
  ['te chunked twice', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked, chunked\r\n\r\n2\r\nhi\r\n0\r\n\r\n'],
  ['te , chunked', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: , chunked\r\n\r\n2\r\nhi\r\n0\r\n\r\n'],
  ['te chunked,', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked,\r\n\r\n2\r\nhi\r\n0\r\n\r\n'],
  ['te empty', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: \r\nContent-Length: 2\r\n\r\nhi'],
  ['te two headers', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhi\r\n0\r\n\r\n'],
  ['te bad token', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: ch@nked\r\n\r\nhi'],
  ['bare lf head', 'HTTP/1.1 200 OK\nContent-Length: 2\n\nhi'],
  ['bare lf status line only', 'HTTP/1.1 200 OK\nContent-Length: 2\r\n\r\nhi'],
  ['bare lf header', 'HTTP/1.1 200 OK\r\nContent-Length: 2\n\r\nhi'],
  ['bare lf end', 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\nhi'],
  ['bare cr status', 'HTTP/1.1 200 OK\rX\r\nContent-Length: 2\r\n\r\nhi'],
  ['no reason', 'HTTP/1.1 200\r\nContent-Length: 2\r\n\r\nhi'],
  ['no reason space', 'HTTP/1.1 200 \r\nContent-Length: 2\r\n\r\nhi'],
  ['two spaces before status', 'HTTP/1.1  200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['status 2 digits', 'HTTP/1.1 20 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['status 4 digits', 'HTTP/1.1 2000 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['status letters', 'HTTP/1.1 2x0 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['status 099', 'HTTP/1.1 099 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['status 999', 'HTTP/1.1 999 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['http/1.0', 'HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['http/2.0', 'HTTP/2.0 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['http/1.2', 'HTTP/1.2 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['http/0.9', 'HTTP/0.9 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['http/3.0', 'HTTP/3.0 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['http/11.1', 'HTTP/11.1 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['lowercase http', 'http/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['not http', 'FOO 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['icy', 'ICY 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['rtsp', 'RTSP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['tab before status', 'HTTP/1.1\t200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['tab in reason', 'HTTP/1.1 200 O\tK\r\nContent-Length: 2\r\n\r\nhi'],
  ['ctl in reason', 'HTTP/1.1 200 O\x01K\r\nContent-Length: 2\r\n\r\nhi'],
  ['high byte in reason', 'HTTP/1.1 200 O\xe9K\r\nContent-Length: 2\r\n\r\nhi'],
  ['leading crlf', '\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['leading space', ' HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['space before header', 'HTTP/1.1 200 OK\r\n Content-Length: 2\r\n\r\nhi'],
  ['obs fold', 'HTTP/1.1 200 OK\r\nX-A: a\r\n b\r\nContent-Length: 2\r\n\r\nhi'],
  ['space in header name', 'HTTP/1.1 200 OK\r\nX A: a\r\nContent-Length: 2\r\n\r\nhi'],
  ['empty header name', 'HTTP/1.1 200 OK\r\n: a\r\nContent-Length: 2\r\n\r\nhi'],
  ['ctl in header value', 'HTTP/1.1 200 OK\r\nX-A: a\x01b\r\nContent-Length: 2\r\n\r\nhi'],
  ['no length, close', 'HTTP/1.1 200 OK\r\n\r\nhi'],
  ['cl and te', 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhi\r\n0\r\n\r\n'],
  ['te and cl', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 2\r\n\r\n2\r\nhi\r\n0\r\n\r\n'],
  ['te gzip and cl', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\nContent-Length: 2\r\n\r\nhi'],
  ['cl +2', 'HTTP/1.1 200 OK\r\nContent-Length: +2\r\n\r\nhi'],
  ['cl empty', 'HTTP/1.1 200 OK\r\nContent-Length: \r\n\r\nhi'],
  ['header overflow', 'HTTP/1.1 200 OK\r\nX: ' + 'a'.repeat(17000) + '\r\nContent-Length: 2\r\n\r\nhi'],
  ['long reason overflow', 'HTTP/1.1 200 ' + 'a'.repeat(17000) + '\r\nContent-Length: 2\r\n\r\nhi'],
  ['chunk ext overflow', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2;' + 'a'.repeat(17000) + '\r\nhi\r\n0\r\n\r\n'],
  ['x major', 'HTTP/x.1 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['x minor', 'HTTP/1.x 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['extra digit minor', 'HTTP/1.10 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['version then x', 'HTTP/1.1x 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['version then CR', 'HTTP/1.1\r\nContent-Length: 2\r\n\r\nhi'],
  ['status then LF', 'HTTP/1.1 200\nContent-Length: 2\r\n\r\nhi'],
  ['status then CR x', 'HTTP/1.1 200\rContent-Length: 2\r\n\r\nhi'],
  ['status then x', 'HTTP/1.1 200x\r\nContent-Length: 2\r\n\r\nhi'],
  ['status then tab', 'HTTP/1.1 200\tOK\r\nContent-Length: 2\r\n\r\nhi'],
  ['status 1 digit then CR', 'HTTP/1.1 2\r\nContent-Length: 2\r\n\r\nhi'],
  ['status 2 digits then CR', 'HTTP/1.1 20\r\nContent-Length: 2\r\n\r\nhi'],
  ['status space then LF', 'HTTP/1.1 200 \nContent-Length: 2\r\n\r\nhi'],
  ['ICE/1.0', 'ICE/1.0 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['ICE/1.1', 'ICE/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['RTSP/1.1', 'RTSP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['RTSP/2.0', 'RTSP/2.0 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['HTTP/1.1 then 2 spaces', 'HTTP/1.1  200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['HT then junk', 'HTX/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['H then LF', 'H\nTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['leading LF', '\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['leading CR CR LF', '\r\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['HTTP/0.0', 'HTTP/0.0 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['HTTP/2.1', 'HTTP/2.1 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['HTTP/9.9', 'HTTP/9.9 200 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['status 000', 'HTTP/1.1 000 OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['te chunked comma space', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked , \r\n\r\n2\r\nhi\r\n0\r\n\r\n'],
  ['te Chunked caps', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: CHUNKED\r\n\r\n2\r\nhi\r\n0\r\n\r\n'],
  ['te chunked then empty header', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: \r\n\r\n2\r\nhi\r\n0\r\n\r\n'],
  ['te chunked then gzip header', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: gzip\r\n\r\nhi'],
  ['te identity', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: identity\r\nContent-Length: 2\r\n\r\nhi'],
  ['cl twice same', 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\nhi'],
  ['cl comma', 'HTTP/1.1 200 OK\r\nContent-Length: 2, 2\r\n\r\nhi'],
  ['cl space inside', 'HTTP/1.1 200 OK\r\nContent-Length: 1 2\r\n\r\nhi'],
  ['cl huge', 'HTTP/1.1 200 OK\r\nContent-Length: 99999999999999999999\r\n\r\nhi'],
  ['head 1.0 keep-alive no length', 'HTTP/1.0 200 OK\r\n\r\nhi'],
  ['two spaces before the reason', 'HTTP/1.1 200  OK\r\nContent-Length: 2\r\n\r\nhi'],
  ['trailing spaces in the reason', 'HTTP/1.1 200 OK  \r\nContent-Length: 2\r\n\r\nhi'],
  ['a reason with a colon', 'HTTP/1.1 200 OK: yes\r\nContent-Length: 2\r\n\r\nhi'],
];

const chunkLines = [
  ['chunk size with a space', '2 '],
  ['chunk size with a bare LF', '2\n'],
  ['chunk extension, empty value', '2;a='],
  ['chunk extension, quoted', '2;a="x y"'],
  ['chunk extension, junk after the quote', '2;a="x"y'],
  ['chunk extension, a space after the semicolon', '2; a'],
  ['chunk extension, 16384 bytes', '2;' + 'a'.repeat(16384)],
  ['chunk extension, 16385 bytes', '2;' + 'a'.repeat(16385)],
];

(async () => {
  for (const [label, wire] of rows) await one(label, Buffer.from(wire, 'latin1'));
  for (const [label, line] of chunkLines) await one(label, Buffer.from(chunked(line), 'latin1'));
  const parts = (...texts) => texts.map((text) => Buffer.from(text, 'latin1'));
  await one('a status line split in the reason', parts('HTTP/1.1 200 O', 'K\r\nContent-Length: 2\r\n\r\nhi'));
  await one('a chunk size line split', parts('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2;a', '=b\r\nhi\r\n0\r\n\r\n'));
  const trailer = (text) => Buffer.from(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhi\r\n0\r\n${text}\r\n\r\n`, 'latin1');
  await one('a trailer', trailer('X-T: yes'));
  await one('a transfer-encoding trailer', trailer('Transfer-Encoding: chunked'));
  await one('a content-length trailer', trailer('Content-Length: 2'));
  await one('a 100 Continue before the response', Buffer.from('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi', 'latin1'));
  await one('a 103 before the response', Buffer.from('HTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi', 'latin1'));
  const big = (n) => Buffer.from(`HTTP/1.1 200 OK\r\nX: ${'a'.repeat(n)}\r\nContent-Length: 2\r\n\r\nhi`, 'latin1');
  await one('maxHeaderSize 64, at the limit', big(46), { maxHeaderSize: 64 });
  await one('maxHeaderSize 64, under it', big(45), { maxHeaderSize: 64 });
  await one('maxHeaderSize 0 is the default', big(16300), { maxHeaderSize: 0 });
  for (const value of [-1, 1.5, '64']) {
    try {
      http.get({ host: '127.0.0.1', port: 1, agent: false, maxHeaderSize: value }).on('error', () => {});
      console.log(`maxHeaderSize ${JSON.stringify(value)} | accepted`);
    } catch (e) {
      console.log(`maxHeaderSize ${JSON.stringify(value)} | ${e.code} ${e.message}`);
    }
  }
  console.log('done');
})();
