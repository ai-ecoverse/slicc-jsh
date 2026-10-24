const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');

const read = (name) => fs.readFileSync(path.join(__dirname, 'keys', name), 'utf8');
const own = { key: read('server.key'), cert: read('server.crt') };
const REPLY = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok';

process.on('exit', (code) => console.log(`exit ${code}`));

function server(secure) {
  let ready;
  const reset = new Promise((resolve) => (ready = resolve));
  const srv = net.createServer((raw) => {
    raw.on('error', () => {});
    const s = secure ? new tls.TLSSocket(raw, { isServer: true, ...own }) : raw;
    s.on('error', () => {});
    let n = 0;
    s.on('data', () => {
      n++;
      s.write(REPLY, () => {
        if (n === 1) ready(() => raw.resetAndDestroy());
      });
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, reset })));
}

function get(mod, agent, port) {
  return new Promise((resolve) => {
    const req = mod.get({ host: '127.0.0.1', port, agent, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ body, socket: req.socket, reused: req.reusedSocket }));
    });
    req.on('error', (e) => resolve({ error: e.code }));
  });
}

async function row(label, mod, agent, secure) {
  const { srv, reset } = await server(secure);
  const port = srv.address().port;
  const first = await get(mod, agent, port);
  const name = Object.keys(agent.freeSockets)[0];
  console.log(`${label}: first ${first.body}, free ${agent.freeSockets[name]?.length ?? 0}`);
  const closed = new Promise((resolve) => first.socket.once('close', resolve));
  (await reset)();
  const hadError = await closed;
  console.log(`${label}: the idle socket closed, hadError ${hadError}, free ${Object.keys(agent.freeSockets).length}, sockets ${Object.keys(agent.sockets).length}`);
  const second = await get(mod, agent, port);
  console.log(`${label}: second ${second.body ?? second.error}, reused ${second.reused}`);
  agent.destroy();
  srv.close();
}

(async () => {
  await row('http.globalAgent', http, http.globalAgent, false);
  await row('a keep-alive http.Agent', http, new http.Agent({ keepAlive: true }), false);
  await row('a keep-alive https.Agent', https, new https.Agent({ keepAlive: true }), true);
  console.log('done');
})();
