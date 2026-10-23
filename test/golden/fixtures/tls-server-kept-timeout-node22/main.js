const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');

const read = (name) => fs.readFileSync(path.join(__dirname, 'keys', name), 'utf8');
const key = read('server.key');
const cert = read('server.crt');

function kept(label, { listener = true, write = false, leave }) {
  return new Promise((resolve) => {
    const ev = [];
    const cev = [];
    let quiet;
    let finished = false;
    const idle = () => {
      clearTimeout(quiet);
      if (finished) return;
      quiet = setTimeout(() => {
        ev.push(`nothing more, still waiting for ${[...waiting].join(', ')}`);
        finish();
      }, 1000);
    };
    for (const list of [ev, cev]) {
      list.push = (...items) => {
        idle();
        return Array.prototype.push.apply(list, items);
      };
    }
    const waiting = new Set(['client close', 'server close callback', ...(listener ? ['server socket close'] : [])]);
    const seen = (what) => {
      waiting.delete(what);
      if (waiting.size === 0) finish();
    };
    const server = tls.createServer({ key, cert, handshakeTimeout: 200 }, () => ev.push('secureConnection'));
    let client;
    let held;
    const goes = () => {
      leave(client);
      server.close(() => {
        ev.push('close callback');
        seen('server close callback');
      });
    };
    if (listener) {
      server.on('tlsClientError', (err, socket) => {
        held = socket;
        ev.push(`tlsClientError ${err.code}, destroyed ${socket.destroyed}`);
        socket.on('data', (d) => ev.push(`socket data ${d.length}`));
        socket.on('end', () => ev.push(`socket end, destroyed ${socket.destroyed}`));
        socket.on('error', (e) => ev.push(`socket error ${e.code}`));
        socket.on('close', (hadError) => {
          ev.push(`socket close ${hadError}, destroyed ${socket.destroyed}`);
          seen('server socket close');
        });
        if (write) socket.write('not before a handshake');
        setTimeout(goes, 100);
      });
    }
    server.listen(0, '127.0.0.1', () => {
      idle();
      client = net.connect(server.address().port, '127.0.0.1');
      let got = 0;
      client.on('data', (d) => (got += d.length));
      client.on('error', (e) => cev.push(`error ${e.code}`));
      client.on('end', () => cev.push('end'));
      client.on('close', () => {
        cev.push(`close, got ${got} bytes`);
        seen('client close');
      });
      if (!listener) setTimeout(goes, 400);
    });
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(quiet);
      console.log(label);
      for (const e of ev) console.log(`  server ${e}`);
      for (const e of cev) console.log(`  client ${e}`);
      client.destroy();
      held?.destroy();
      server.close();
      resolve();
    }
  });
}

(async () => {
  await kept('the client ends after the timeout', { leave: (c) => c.end() });
  await kept('the client is destroyed after the timeout', { leave: (c) => c.destroy() });
  await kept('the program writes to the kept socket, then the client ends', { write: true, leave: (c) => c.end() });
  await kept('no tlsClientError listener, the client ends', { listener: false, leave: (c) => c.end() });
  console.log('done');
})();
