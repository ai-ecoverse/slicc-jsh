const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { execFile, spawn } = require('child_process');
const { monitorEventLoopDelay } = require('perf_hooks');
for (const name of ['setImmediate', 'setTimeout', 'setInterval', 'clearImmediate', 'clearTimeout', 'clearInterval', 'queueMicrotask']) {
  globalThis[name] = undefined;
  require('timers')[name] = undefined;
}
const step = (name, run) => new Promise((resolve) => run((err, ...rest) => { console.log(name, err ? err.code ?? err.message : 'ok', ...rest); resolve(); }));
(async () => {
  await step('randomBytes', (cb) => crypto.randomBytes(8, (err, b) => cb(err, b.length)));
  await step('randomFill', (cb) => crypto.randomFill(Buffer.alloc(4), (err, b) => cb(err, b.length)));
  await step('generateKey', (cb) => crypto.generateKey('hmac', { length: 64 }, (err, k) => cb(err, k.type)));
  await step('pbkdf2', (cb) => crypto.pbkdf2('p', 's', 1, 8, 'sha256', (err, k) => cb(err, k.toString('hex'))));
  await step('scrypt', (cb) => crypto.scrypt('p', 's', 8, (err, k) => cb(err, k.toString('hex'))));
  await step('gzip', (cb) => zlib.gzip('hello', (err, z) => zlib.gunzip(z, (err2, s) => cb(err || err2, String(s)))));
  await step('deflate stream', (cb) => { const chunks = []; zlib.createDeflate().on('data', (c) => chunks.push(c)).on('end', () => zlib.inflate(Buffer.concat(chunks), (e, s) => cb(e, String(s)))).end('stream'); });
  await step('readFile', (cb) => fs.readFile(__filename, (err, b) => cb(err, b.length > 0)));
  await step('execFile', (cb) => execFile(process.execPath, ['-e', 'console.log(42)'], { timeout: 10000 }, (err, out) => cb(err, out.trim())));
  await step('execFile missing', (cb) => execFile('/no/such/command', (err) => cb(null, err.code)));
  await step('spawn missing', (cb) => { const events = []; spawn('/no/such/command').on('error', (err) => events.push(`error ${err.code}`)).on('close', (code) => { events.push(`close ${code}`); cb(null, events.join(', ')); }); });
  await step('monitorEventLoopDelay', (cb) => { const h = monitorEventLoopDelay(); h.enable(); h.disable(); cb(null); });
  await step('net', (cb) => {
    const server = net.createServer((s) => { s.setTimeout(10000); s.end('hi'); });
    server.listen(0, '127.0.0.1', () => {
      const c = net.connect(server.address().port, '127.0.0.1');
      c.setTimeout(10000);
      let data = '';
      c.on('data', (d) => (data += d)).on('close', () => server.close(() => cb(null, data)));
    });
  });
  await step('http', (cb) => {
    const server = http.createServer((req, res) => res.end('hello'));
    server.listen(0, '127.0.0.1', () => {
      http.get({ port: server.address().port, host: '127.0.0.1', agent: false }, (res) => {
        let data = '';
        res.on('data', (d) => (data += d)).on('end', () => server.close(() => cb(null, data)));
      });
    });
  });
})();
process.on('exit', () => console.log('the program ends'));
