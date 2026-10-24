const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const https = require('https');

const read = (name) => fs.readFileSync(path.join(__dirname, 'keys', name), 'utf8');
const own = { key: read('server.key'), cert: read('server.crt') };
const LINE = /^([A-Z_0-9]+) ([0-9a-f]{64}) ([0-9a-f]+)\n$/;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function shape(all) {
  const parsed = all.map((b) => [Buffer.isBuffer(b), LINE.exec(b.toString('latin1'))]);
  const ok = parsed.every(([buffer, m]) => buffer && m);
  const labels = parsed.map(([, m]) => m?.[1]).sort();
  return { ok, labels, parsed, count: all.length };
}

function compare(name, client, server, extra = []) {
  const c = shape(client);
  const s = shape(server);
  console.log(name);
  console.log(`  client: ${c.count} lines, NSS format ${c.ok}, ${c.labels.join(' ')}`);
  console.log(`  server: ${s.count} lines, NSS format ${s.ok}, ${s.labels.join(' ')}`);
  const randoms = new Set([...c.parsed, ...s.parsed].map(([, m]) => m?.[2]));
  console.log(`  one client random: ${randoms.size === 1}`);
  const secrets = (p) => p.map(([, m]) => `${m?.[1]} ${m?.[3]}`).sort().join('\n');
  console.log(`  the same secrets on both sides: ${secrets(c.parsed) === secrets(s.parsed)}`);
  for (const line of extra) console.log(`  ${line}`);
}

(async () => {
  {
    const client = [];
    const server = [];
    let given;
    let early;
    const srv = tls.createServer(own, (socket) => socket.end('hi'));
    srv.on('keylog', (line, socket) => {
      server.push(line);
      given ??= socket instanceof tls.TLSSocket;
    });
    const port = await listen(srv);
    await new Promise((resolve) => {
      const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false });
      socket.on('keylog', (line) => client.push(line));
      socket.on('secureConnect', () => (early = client.length > 0));
      socket.resume();
      socket.on('close', resolve);
    });
    srv.close();
    compare('tls.connect and tls.Server', client, server, [`lines before secureConnect: ${early}`, `the server's keylog gives a TLSSocket: ${given}`]);
  }

  {
    const client = [];
    const server = [];
    const srv = https.createServer(own, (req, res) => res.end('ok'));
    srv.on('keylog', (line) => server.push(line));
    const port = await listen(srv);
    await new Promise((resolve) => {
      const agent = new https.Agent({ rejectUnauthorized: false });
      agent.on('keylog', (line) => client.push(line));
      https.get({ host: '127.0.0.1', port, agent }, (res) => {
        res.resume();
        res.on('end', () => {
          agent.destroy();
          resolve();
        });
      });
    });
    srv.close();
    compare('https.Agent and https.Server', client, server);
  }

  {
    const client = [];
    const server = [];
    const plain = net.createServer((raw) => {
      const socket = new tls.TLSSocket(raw, { isServer: true, ...own });
      socket.on('keylog', (line) => server.push(line));
      socket.on('secure', () => socket.end('hi'));
    });
    const port = await listen(plain);
    await new Promise((resolve) => {
      const raw = net.connect(port, '127.0.0.1', () => {
        const socket = tls.connect({ socket: raw, rejectUnauthorized: false });
        socket.on('keylog', (line) => client.push(line));
        socket.resume();
        socket.on('close', resolve);
      });
    });
    plain.close();
    compare('TLS over a socket, both ends', client, server);
  }
})();
