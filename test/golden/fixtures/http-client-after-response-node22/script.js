const http = require('http');
const net = require('net');
const { EventEmitter } = require('events');

const row = (label, parts, { method = 'GET', agent = false, read = true } = {}) =>
  new Promise((resolve) => {
    const stage = new EventEmitter();
    const srv = net.createServer((s) => {
      s.on('error', () => {});
      s.once('data', () => {
        const queue = [...parts];
        const next = () => {
          const part = queue.shift();
          if (part === undefined) {
            stage.emit('written');
            return s.end();
          }
          if (typeof part === 'object') return stage.once(part.after, next);
          s.write(part, next);
        };
        next();
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const events = [];
      const pool = agent === 'keep-alive' ? new http.Agent({ keepAlive: true }) : agent;
      const req = http.request({ host: '127.0.0.1', port: srv.address().port, agent: pool, method }, (res) => {
        events.push(`response ${res.statusCode}`);
        let body = '';
        if (read) res.on('data', (d) => (body += d));
        else stage.once('written', () => res.on('data', (d) => (body += d)));
        res.on('end', () => {
          events.push(`end ${JSON.stringify(body)}`);
          stage.emit('end');
        });
        res.on('close', () => events.push('res close'));
        stage.emit('response');
      });
      req.on('error', (e) => events.push(`error ${e.code} ${JSON.stringify(e.message)}`));
      req.on('close', () => {
        events.push('req close');
        setImmediate(() => {
          console.log(`${label} | ${events.join(', ')}`);
          if (pool) pool.destroy();
          srv.close(resolve);
        });
      });
      req.end();
    });
  });

const ok = (extra = '') => `HTTP/1.1 200 OK\r\nContent-Length: 2\r\n${extra}\r\nhi`;
const chunked = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhi\r\n0\r\n\r\n';

(async () => {
  await row('content-length, then junk in the same packet', [ok() + 'junk']);
  await row('content-length, then junk once the response ended', [ok(), { after: 'end' }, 'junk']);
  await row('a keep-alive agent, junk in the same packet', [ok() + 'junk'], { agent: 'keep-alive' });
  await row('a keep-alive agent, junk once the response ended', [ok(), { after: 'end' }, 'junk'], { agent: 'keep-alive' });
  await row('chunked, then junk in the same packet', [chunked + 'junk']);
  await row('chunked, then junk once the response ended', [chunked, { after: 'end' }, 'junk']);
  await row('a trailer, then junk', ['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhi\r\n0\r\nX-T: 1\r\n\r\njunk']);
  await row('204, then junk', ['HTTP/1.1 204 No Content\r\n\r\nhi']);
  await row('304, then junk once the response ended', ['HTTP/1.1 304 Not Modified\r\n\r\n', { after: 'end' }, 'hi']);
  await row('HEAD, then the body anyway', [ok()], { method: 'HEAD' });
  await row('the head, then the body and junk in the next packet', ['HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n', { after: 'response' }, 'hijunk']);
  await row('the body split, junk with its last byte', [ok().slice(0, -1), { after: 'response' }, 'ijunk']);
  await row('100 Continue, a response, then junk', ['HTTP/1.1 100 Continue\r\n\r\n' + ok() + 'junk']);
  await row('junk once the response arrived, read later', [ok(), { after: 'response' }, 'junk'], { read: false });
  await row('a second response in the same packet', [ok() + ok()]);
  await row('a keep-alive agent, a second response in the same packet', [ok() + ok()], { agent: 'keep-alive' });
  await row('a second response once the response ended', [ok(), { after: 'end' }, ok()]);
  await row('a partial second head', [ok() + 'HTTP/1.1 200']);
  await row('a bad second status line', [ok() + 'HTTP/1.1 20 OK\r\n\r\n']);
  await row('a bad second header', [ok() + 'HTTP/1.1 200 OK\r\nBad Name: x\r\n\r\n']);
  await row('CRLF after the body', [ok() + '\r\n']);
  await row('CRLFs after the body', [ok() + '\r\n\r\n']);
  await row('CRLF, then junk', [ok() + '\r\njunk']);
  await row('a body read until close, then more', ['HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nhi', { after: 'response' }, 'more']);
  console.log('done');
})();
