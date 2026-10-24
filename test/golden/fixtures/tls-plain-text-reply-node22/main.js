const net = require('net');
const tls = require('tls');

const replies = [
  ['a word', 'nope\n'],
  ['an HTTP response', 'HTTP/1.1 400 Bad Request\r\n\r\n'],
  ['an IMAP greeting', '* OK IMAP ready\r\n'],
  ['an SMTP greeting', '220 smtp.example ESMTP ready\r\n'],
  ['an SSH banner', 'SSH-2.0-OpenSSH_9.6\r\n'],
  ['a POP3 greeting', '+OK POP3 ready\r\n'],
  ['six zero bytes', Buffer.alloc(6)],
  ['a handshake record of 16385 bytes', Buffer.from([0x16, 0x03, 0x03, 0x40, 0x01])],
  ['a handshake record that is no ServerHello', Buffer.concat([Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05]), Buffer.from('hello')])],
  ['an HTTP GET', 'GET / HTTP/1.1\r\n\r\n'],
  ['an HTTP PUT', 'PUT / HTTP/1.1\r\n\r\n'],
];

const ways = {
  connect: (port) => tls.connect(port, '127.0.0.1', { rejectUnauthorized: false }),
  socket: (port) => tls.connect({ socket: net.connect(port, '127.0.0.1'), rejectUnauthorized: false }),
};

function row(label, reply, way = 'connect') {
  return new Promise((resolve) => {
    const ev = [];
    const srv = net.createServer((c) => {
      c.on('error', () => {});
      c.resume();
      c.end(reply);
    });
    srv.listen(0, '127.0.0.1', () => {
      const t = ways[way](srv.address().port);
      t.on('secureConnect', () => ev.push('secureConnect'));
      t.on('error', (e) => {
        const message = e.message.replace(/^[0-9A-F]+:error:/, 'error:').replace(/:[^:]*:\d+:\n$/, '');
        ev.push(`error ${e.code}`, `  message ${JSON.stringify(message)}`, `  library ${e.library}, reason ${e.reason}`);
      });
      t.on('close', (hadError) => {
        ev.push(`close ${hadError}`);
        srv.close(() => {
          console.log(label);
          for (const e of ev) console.log(`  ${e}`);
          resolve();
        });
      });
    });
  });
}

(async () => {
  for (const [label, reply] of replies) await row(label, reply);
  await row('over a socket, a word', 'nope\n', 'socket');
  await row('over a socket, an SMTP greeting', '220 smtp.example ESMTP ready\r\n', 'socket');
  console.log('done');
})();
