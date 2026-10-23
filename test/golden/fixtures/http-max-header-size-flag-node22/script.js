const http = require('http');
const net = require('net');

const serve = (options, url) =>
  new Promise((resolve) => {
    let result = 'no error';
    const srv = http.createServer(options, (req, res) => res.end('ok'));
    srv.on('clientError', (e, s) => {
      result = e.code;
      s.destroy();
    });
    srv.listen(0, '127.0.0.1', () => {
      const c = net.connect(srv.address().port, '127.0.0.1');
      let got = '';
      c.on('connect', () => c.write(`GET ${url} HTTP/1.1\r\nHost: x\r\n\r\n`));
      c.on('data', (d) => {
        got += d;
        if (got.endsWith('ok')) c.end();
      });
      c.on('error', () => {});
      c.on('close', () => srv.close(() => resolve(`${result}, ${got.split('\r\n')[0] || '-'}`)));
    });
  });

const fetch = (options, reason) =>
  new Promise((resolve) => {
    const srv = net.createServer((s) => {
      s.on('error', () => {});
      s.once('data', () => s.end(`HTTP/1.1 200 ${reason}\r\nContent-Length: 2\r\n\r\nhi`));
    });
    srv.listen(0, '127.0.0.1', () => {
      let result = '';
      const req = http.get({ host: '127.0.0.1', port: srv.address().port, agent: false, ...options }, (res) => {
        result = `response ${res.statusCode}`;
        res.resume();
      });
      req.on('error', (e) => (result = e.code));
      req.on('close', () => srv.close(() => resolve(result)));
    });
  });

(async () => {
  console.log(`http.maxHeaderSize ${http.maxHeaderSize}`);
  console.log(`server, a target of 94 | ${await serve({}, `/${'a'.repeat(93)}`)}`);
  console.log(`server, a target of 95 | ${await serve({}, `/${'a'.repeat(94)}`)}`);
  console.log(`server with maxHeaderSize 200 | ${await serve({ maxHeaderSize: 200 }, `/${'a'.repeat(150)}`)}`);
  console.log(`client, a reason of 84 | ${await fetch({}, 'r'.repeat(84))}`);
  console.log(`client, a reason of 85 | ${await fetch({}, 'r'.repeat(85))}`);
  console.log(`client with maxHeaderSize 200 | ${await fetch({ maxHeaderSize: 200 }, 'r'.repeat(150))}`);
  const { execFileSync } = require('child_process');
  for (const value of ['12abc', '+12', '-5', '99999999999999999999999', '0x10']) {
    const out = execFileSync(process.execPath, [`--max-http-header-size=${value}`, '-p', "require('http').maxHeaderSize"], { encoding: 'utf8' });
    console.log(`--max-http-header-size=${value} | ${out.trim()}`);
  }
  for (const argv of [['--max-http-header-size'], ['--no-max-http-header-size']]) {
    try {
      execFileSync(process.execPath, [...argv, '-p', '1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      console.log(`${argv.join(' ')} | status ${e.status} | ${e.stderr.trim().replace(/^[^:]*: /, 'node: ')}`);
    }
  }
  const out = execFileSync(process.execPath, ['-p', "require('http').maxHeaderSize"], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--max-http-header-size=55' } });
  console.log(`NODE_OPTIONS | ${out.trim()}`);
})();
