import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withJsh } from './helpers.mjs';

const program = `
const http = require('http');
const net = require('net');
const cases = {
  '/head-sent': (res) => { res.flushHeaders(); res.cork(); res.write('hello'); res.end(); },
  '/head-unsent': (res) => { res.cork(); res.write('ab'); res.write('cd'); res.end(); },
  '/end-body': (res) => { res.flushHeaders(); res.cork(); res.write('a'); res.end('b'); },
  '/trailers': (res) => { res.flushHeaders(); res.cork(); res.write('a'); res.addTrailers({ 'X-T': '1' }); res.end(); },
  '/strict': (res, req) => {
    res.setHeader('Content-Length', '10');
    res.strictContentLength = true;
    try { res.end('hi'); } catch (err) { console.log('strict', err.code, res.finished); }
    req.socket.write('', () => req.socket.destroy());
  },
};
const closed = new Map();
const server = http.createServer((req, res) => {
  if (req.url === '/next') return res.end('next');
  res.on('close', () => closed.get(req.url)());
  cases[req.url](res, req);
});
server.listen(0, '127.0.0.1', async () => {
  for (const path of Object.keys(cases)) {
    await new Promise((resolve) => {
      const s = net.connect(server.address().port, '127.0.0.1', () => s.write('GET ' + path + ' HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n'));
      closed.set(path, () => path !== '/strict' && s.write('GET /next HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n'));
      let wire = '';
      s.on('data', (d) => (wire += d.toString('latin1')));
      s.on('error', () => {});
      s.on('close', () => {
        console.log(path, JSON.stringify(wire.replace(/Date: [^\\r]*\\r\\n/g, '')));
        resolve();
      });
    });
  }
  server.close();
});
`;

const head = 'HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\nTransfer-Encoding: chunked\r\n\r\n';
const next = 'HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 4\r\n\r\nnext';

describe('http: end() keeps the framing whole (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
  });
  after(() => jsh?.close());

  it('sends the corked chunks before the last chunk, and a strictContentLength mismatch in end() sends nothing', async () => {
    await jsh.kernel.writeFile('/os/end-corked.js', program);
    const r = await jsh.run(['node', 'end-corked.js']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout,
      [
        `/head-sent ${JSON.stringify(`${head}5\r\nhello\r\n0\r\n\r\n${next}`)}`,
        `/head-unsent ${JSON.stringify(`${head}2\r\nab\r\n2\r\ncd\r\n0\r\n\r\n${next}`)}`,
        `/end-body ${JSON.stringify(`${head}2\r\nab\r\n0\r\n\r\n${next}`)}`,
        `/trailers ${JSON.stringify(`${head}1\r\na\r\n0\r\nX-T: 1\r\n\r\n${next}`)}`,
        'strict ERR_HTTP_CONTENT_LENGTH_MISMATCH false',
        '/strict ""',
        '',
      ].join('\n')
    );
  });
});
