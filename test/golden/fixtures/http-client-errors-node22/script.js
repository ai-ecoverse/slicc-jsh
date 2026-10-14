const net = require('net');
const http = require('http');
const https = require('https');

const shape = (e) => {
  const o = { name: e.name, code: e.code, syscall: e.syscall, message: e.message };
  if (e.code === 'ENOTFOUND') Object.assign(o, { errno: e.errno, hostname: e.hostname });
  else Object.assign(o, { address: e.address, port: e.port });
  return JSON.stringify(o);
};
const once = (label, start) =>
  new Promise((resolve) => {
    const t = start();
    t.on('error', (e) => {
      console.log(`${label}: ${shape(e)}`);
      resolve();
    });
    t.on?.('response', (r) => {
      console.log(`${label}: response ${r.statusCode}`);
      r.resume();
      resolve();
    });
    t.on?.('connect', () => {
      console.log(`${label}: connected`);
      t.destroy();
      resolve();
    });
  });

(async () => {
  await once('net refused', () => net.connect(1, '127.0.0.1'));
  await once('net unknown name', () => net.connect(80, 'no-such-host.invalid'));
  await once('net unknown name (options)', () => net.connect({ host: 'no-such-host.invalid', port: 8080 }));
  await once('http refused', () => http.get('http://127.0.0.1:1/'));
  await once('http unknown name', () => http.get('http://no-such-host.invalid/x'));
  await once('http unknown name, port', () => http.request({ host: 'no-such-host.invalid', port: 8080, method: 'POST' }).end('b'));
  await once('https unknown name', () => https.get('https://no-such-host.invalid/'));
})();
