const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');

const read = (name) => fs.readFileSync(path.join(__dirname, 'keys', name), 'utf8');
const own = { key: read('server.key'), cert: read('server.crt') };

function row(label, act, { quiet = false } = {}) {
  return new Promise((resolve) => {
    const sev = [];
    const cev = [];
    const hooks = {};
    const waiting = new Set(['server', 'client']);
    const seen = (what) => {
      waiting.delete(what);
      if (waiting.size) return;
      setImmediate(() => {
        console.log(label);
        for (const e of sev) console.log(`  server ${e}`);
        if (!quiet) for (const e of cev) console.log(`  client ${e}`);
        resolve();
      });
    };
    const server = tls.createServer(own, (socket) => {
      socket.on('data', (d) => {
        sev.push(`data ${JSON.stringify(String(d))}`);
        hooks.data?.();
      });
      socket.on('end', () => sev.push('end'));
      socket.on('error', (e) => sev.push(`error ${e.code}`));
      socket.on('close', (hadError) => {
        sev.push(`close ${hadError}`);
        server.close(() => seen('server'));
      });
      socket.write('hi');
    });
    server.on('tlsClientError', (e) => {
      sev.push(`tlsClientError ${e.code}`);
      server.close(() => seen('server'));
    });
    server.listen(0, '127.0.0.1', () => {
      const ends = (s, name) => {
        s.on('error', (e) => cev.push(`${name} error ${e.code}`));
        s.on('close', (hadError) => {
          cev.push(`${name} close ${hadError}`);
          if (name === 'tls') seen('client');
        });
      };
      act(server.address().port, { cev, hooks, ends });
    });
  });
}

const overSocket = (port, ends, then) => {
  const raw = net.connect(port, '127.0.0.1', () => {
    const c = tls.connect({ socket: raw, rejectUnauthorized: false });
    ends(c, 'tls');
    then(raw, c);
  });
  ends(raw, 'raw');
};

(async () => {
  await row('a TLS socket resets', (port, { cev, ends }) => {
    const c = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false });
    ends(c, 'tls');
    c.once('data', () => {
      try {
        c.resetAndDestroy();
        cev.push('reset');
      } catch (e) {
        cev.push(`throws ${e.name} ${e.code} ${e.message}`);
      }
      c.destroy();
      cev.push(`returns the socket once destroyed ${c.resetAndDestroy() === c}`);
    });
  });
  await row('the socket under TLS resets', (port, { cev, ends }) =>
    overSocket(port, ends, (raw, c) =>
      c.once('data', () => {
        raw.resetAndDestroy();
        cev.push(`reset, raw destroyed ${raw.destroyed}`);
      })
    )
  );
  await row('the socket under TLS resets once the server has read what the client wrote', (port, { hooks, ends }) =>
    overSocket(port, ends, (raw, c) => {
      hooks.data = () => raw.resetAndDestroy();
      c.once('data', () => c.write('ping'));
    })
  );
  await row('the socket under TLS resets during the handshake, as the server sees it', (port, { ends }) =>
    overSocket(port, ends, (raw) => raw.resetAndDestroy()),
    { quiet: true }
  );
  await row('the socket under TLS is destroyed during the handshake, as the server sees it', (port, { ends }) =>
    overSocket(port, ends, (raw) => raw.destroy()),
    { quiet: true }
  );
  console.log('done');
})();
