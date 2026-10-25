const net = require('net');
const tls = require('tls');
const https = require('https');
const os = require('os');

const shown = (e, port) =>
  JSON.stringify({
    name: e.name,
    message: e.message.replace(`:${port}`, ':<port>'),
    code: e.code,
    errno: e.errno === undefined ? undefined : e.errno === -os.constants.errno[e.code],
    syscall: e.syscall,
    ...(e.syscall === 'connect' ? { address: e.address, port: e.port === port } : {}),
    keys: Object.keys(e),
  });

function resetting(when) {
  return new Promise((resolve) => {
    const server = net.createServer((s) => {
      if (when === 'accept') s.resetAndDestroy();
      else s.once('data', () => (when === 'hello' ? s.resetAndDestroy() : s.end()));
      s.on('error', () => {});
      s.on('close', () => server.close());
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const verb = (when) => (when === 'accept' ? 'resets as it accepts' : `${when === 'end' ? 'ends' : 'resets'} on the ClientHello`);

function row(label, server, act) {
  return new Promise((resolve) => {
    const ev = [];
    act(server.address().port, ev, () => {
      setImmediate(() => {
        console.log(label);
        for (const e of ev) console.log(`  ${e}`);
        server.close();
        resolve();
      });
    });
  });
}

(async () => {
  for (const when of ['hello', 'end', 'accept']) {
    await row(`tls.connect, the server ${verb(when)}`, await resetting(when), (port, ev, done) => {
      const c = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false });
      c.on('secureConnect', () => ev.push('secureConnect'));
      c.on('error', (e) => ev.push(`error ${shown(e, port)}`));
      c.on('close', (hadError) => {
        ev.push(`close ${hadError}`);
        done();
      });
    });
    await row(`https.request, the server ${verb(when)}`, await resetting(when), (port, ev, done) => {
      const req = https.request({ port, host: '127.0.0.1', rejectUnauthorized: false });
      req.on('error', (e) => ev.push(`error ${shown(e, port)}`));
      req.on('close', () => {
        ev.push('close');
        done();
      });
      req.end();
    });
  }
})();
