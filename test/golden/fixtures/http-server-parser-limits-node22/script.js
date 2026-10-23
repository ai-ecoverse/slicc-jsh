const http = require('http');
const net = require('net');

const shot = (label, chunks, { create = {}, clientError = true, bound = 5000 } = {}) =>
  new Promise((resolve) => {
    const seen = [];
    const errors = [];
    const srv = http.createServer(create, (req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        seen.push(`${req.method} ${req.url.length > 40 ? `${req.url.slice(0, 20)}…(${req.url.length})` : req.url} ${JSON.stringify(body.length > 40 ? `${body.length} bytes` : body)}`);
        res.end('ok');
      });
    });
    if (clientError) {
      srv.on('clientError', (e, s) => {
        errors.push(`${e.code} ${JSON.stringify(e.message)}`);
        s.destroy();
      });
    }
    srv.listen(0, '127.0.0.1', () => {
      const c = net.connect(srv.address().port, '127.0.0.1');
      let got = '';
      let open = false;
      const timer = setTimeout(() => {
        open = true;
        c.destroy();
      }, bound);
      c.on('connect', () => {
        const [first, ...rest] = chunks;
        c.write(Buffer.from(first, 'latin1'));
        for (const more of rest) setImmediate(() => c.write(Buffer.from(more, 'latin1')));
      });
      c.on('data', (d) => {
        got += d;
        if (/\r\n\r\n(ok|)$/.test(got)) c.end();
      });
      c.on('error', () => {});
      c.on('close', () => {
        clearTimeout(timer);
        const wire = got.replace(/\r\nDate: [^\r\n]*/g, '').split('\r\n')[0] || '-';
        console.log(`${label} | ${seen.join(' || ') || '-'} | ${errors.join(', ') || '-'} | ${wire} | ${open ? 'open' : 'closed'}`);
        srv.close(resolve);
      });
    });
  });

const head = 'POST /c HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n';
const chunk = (line, data = 'hello') => `${head}${line}\r\n${data}\r\n0\r\n\r\n`;
const raw = (text) => `${head}${text}`;
const get = (url, headers = 'Host: x\r\n') => `GET ${url} HTTP/1.1\r\n${headers}\r\n`;
const small = { create: { maxHeaderSize: 64 } };

(async () => {
  await shot('extension name of 16384 bytes', [chunk(`5;${'n'.repeat(16384)}`)]);
  await shot('extension name of 16385 bytes', [chunk(`5;${'n'.repeat(16385)}`)]);
  await shot('name and value of 16384 bytes', [chunk(`5;${'n'.repeat(8192)}=${'v'.repeat(8192)}`)]);
  await shot('name and value of 16385 bytes', [chunk(`5;${'n'.repeat(8192)}=${'v'.repeat(8193)}`)]);
  await shot('quoted value, 16384 with the quotes', [chunk(`5;n="${'v'.repeat(16381)}"`)]);
  await shot('quoted value, 16385 with the quotes', [chunk(`5;n="${'v'.repeat(16382)}"`)]);
  await shot('quoted pairs count both bytes', [chunk(`5;n="${'\\v'.repeat(8191)}"`)]);
  await shot('two extensions of 16384 bytes', [chunk(`5;${'a'.repeat(8192)};${'b'.repeat(8192)}`)]);
  await shot('two extensions of 16385 bytes', [chunk(`5;${'a'.repeat(8192)};${'b'.repeat(8193)}`)]);
  await shot('an unterminated extension', [raw(`1;a=${'b'.repeat(20000)}`)]);
  await shot('an unterminated extension over two packets', [raw(`1;a=${'b'.repeat(10000)}`), 'b'.repeat(10000)]);
  await shot('a bad character past the limit', [chunk(`5;a=${'b'.repeat(20000)} x`)]);
  await shot('a bad character before a long extension', [chunk(`5;a= ${'b'.repeat(20000)}`)]);
  await shot('the count starts again for each chunk', [`${head}1;${'a'.repeat(10000)}\r\nz\r\n1;${'a'.repeat(10000)}\r\nz\r\n0\r\n\r\n`]);
  await shot('an extension on the last chunk', [`${head}0;${'a'.repeat(16385)}\r\n\r\n`]);
  await shot('a long run of zeros', [`${head}${'0'.repeat(100000)}5\r\nhello\r\n0\r\n\r\n`]);
  await shot('an extension overflow without a clientError listener', [chunk(`5;${'n'.repeat(16385)}`)], { clientError: false });
  await shot('a bad chunk size without a clientError listener', [chunk('x')], { clientError: false });
  await shot('a bad trailer before its line ends', [`${head}5\r\nhello\r\n0\r\nBad Name`]);

  for (const [label, line, data] of [
    ['a space after the size', '5 '],
    ['a tab after the size', '5\t'],
    ['a size that is not hex', 'x'],
    ['a bare LF after the size', '5\nhello\r\n0\r\n\r\n', null],
    ['a CR without LF after the size', '5\rhello\r\n0\r\n\r\n', null],
    ['a semicolon and nothing', '5;'],
    ['a space after the semicolon', '5; a'],
    ['a tab after the semicolon', '5;\ta'],
    ['a space in the name', '5;a b'],
    ['an empty extension name', '5;;a'],
    ['an empty name with a value', '5;=b'],
    ['an empty value', '5;a='],
    ['a space in the value', '5;a=b c'],
    ['a quoted value with a space', '5;a="b c"'],
    ['a control character in a quoted value', '5;a="b\x01"'],
    ['a control character in a quoted pair', '5;a="b\\\x01"'],
    ['junk after the closing quote', '5;a="b"c'],
    ['a quote inside a token value', '5;a=b"c"'],
    ['a bare LF after a name', '5;a\nhello\r\n0\r\n\r\n', null],
    ['a bare LF after a value', '5;a=b\nhello\r\n0\r\n\r\n', null],
    ['a bare LF after a quoted value', '5;a="b"\nhello\r\n0\r\n\r\n', null],
    ['a DEL in a quoted value', '5;a="b\x7f"'],
    ['a high byte in a quoted value', '5;a="b\xe9"'],
    ['a semicolon after a quoted value', '5;a="b";c'],
  ]) {
    await shot(`chunk line: ${label}`, [data === null ? raw(line) : chunk(line)]);
  }

  await shot('a target of 63 bytes with maxHeaderSize 64', [get(`/${'a'.repeat(62)}`, '')], small);
  await shot('a target of 64 bytes with maxHeaderSize 64', [get(`/${'a'.repeat(63)}`, '')], small);
  await shot('target, name and value make 64', [get(`/${'a'.repeat(57)}`)], small);
  await shot('leading whitespace is not counted', [get('/', `Host:${' '.repeat(40)}${'a'.repeat(58)}\r\n`)], small);
  await shot('trailing whitespace is counted', [get('/', `Host: ${'a'.repeat(48)}${' '.repeat(10)}\r\n`)], small);
  await shot('separators and line ends are not counted', [get('/', 'Host: x\r\n' + 'a: b\r\n'.repeat(28))], small);
  await shot('one header too many', [get('/', 'Host: x\r\n' + 'a: b\r\n'.repeat(29))], small);
  await shot('empty values count nothing', [get('/', 'Host: x\r\n' + 'a:\r\n'.repeat(57))], small);
  await shot('a partial target over the limit', [`GET /${'a'.repeat(100)}`], small);
  await shot('a partial value over the limit', [`GET / HTTP/1.1\r\nHost: ${'a'.repeat(100)}`], small);
  await shot('a target split over the limit', [`GET /${'a'.repeat(40)}`, `${'a'.repeat(40)} HTTP/1.1\r\n\r\n`], small);
  await shot('a bad header name before the limit', [`GET / HTTP/1.1\r\nBad Name${'a'.repeat(100)}`], small);
  await shot('a bad request line before a bad header', ['get / HTTP/1.1\r\nBad Name: y\r\n\r\n']);
  await shot('trailers count from the last chunk', [`POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nz\r\n0\r\nT: ${'a'.repeat(62)}\r\n\r\n`], small);
  await shot('trailers over the limit', [`POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nz\r\n0\r\nT: ${'a'.repeat(63)}\r\n\r\n`], small);
  await shot('a header of 16383 counted bytes', [get('/', `Host: ${'a'.repeat(16378)}\r\n`)]);
  await shot('a header of 16384 counted bytes', [get('/', `Host: ${'a'.repeat(16379)}\r\n`)]);
  await shot('maxHeaderSize 0 is the default', [get('/', `Host: ${'a'.repeat(16378)}\r\n`)], { create: { maxHeaderSize: 0 } });
  await shot('a header overflow without a clientError listener', [get('/', `Host: ${'a'.repeat(16379)}\r\n`)], { clientError: false });
  await shot('leading CRLFs before a request', ['\r\n\r\n' + get('/lead')]);
  for (const value of [-1, 1.5, '64', null]) {
    try {
      http.createServer({ maxHeaderSize: value });
      console.log(`maxHeaderSize ${JSON.stringify(value)} | accepted`);
    } catch (e) {
      console.log(`maxHeaderSize ${JSON.stringify(value)} | ${e.code} ${e.message}`);
    }
  }
  console.log(`http.maxHeaderSize ${http.maxHeaderSize}`);
  console.log('done');
})();
