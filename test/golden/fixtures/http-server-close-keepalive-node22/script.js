// server.close(cb) with keep-alive connections, as Node 22: a connection
// busy when close() is called stays open after its response (Keep-Alive is
// still announced, a further request on it is served), and the callback
// waits until it closes: after keepAliveTimeout + keepAliveTimeoutBuffer
// idle, or at once when the client's agent can't reuse it (a hint of
// timeout=1 leaves nothing after agentKeepAliveTimeoutBuffer).
const http = require('http');
const net = require('net');

const kept = () =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const ev = [];
    let agent;
    const srv = http.createServer((req, res) => {
      srv.close(() => {
        ev.push(`close cb ${Date.now() - t0 >= 3200 ? 'after the idle timeout' : 'early'}`);
        agent.destroy();
        resolve(ev.join(' | '));
      });
      setTimeout(() => res.end('x'), 50);
    });
    srv.keepAliveTimeout = 2500;
    console.log('buffers', srv.keepAliveTimeoutBuffer, new http.Agent().agentKeepAliveTimeoutBuffer);
    srv.listen(0, '127.0.0.1', () => {
      agent = new http.Agent({ keepAlive: true });
      http.get({ host: '127.0.0.1', port: srv.address().port, agent }, (res) => {
        res.resume();
        res.on('end', () => {
          ev.push(`response ${res.headers.connection} ${res.headers['keep-alive']}`);
          setTimeout(() => ev.push(`at +500 ms the cb has${ev.some((e) => e.startsWith('close cb')) ? '' : ' not'} fired`), 500);
        });
      });
    });
  });

const short = () =>
  new Promise((resolve) => {
    const ev = [];
    const srv = http.createServer((req, res) => {
      srv.close(() => {
        ev.push('close cb');
        resolve(ev.join(' | '));
      });
      setTimeout(() => res.end('x'), 50);
    });
    srv.keepAliveTimeout = 1500;
    srv.listen(0, '127.0.0.1', () => {
      const agent = new http.Agent({ keepAlive: true });
      http.get({ host: '127.0.0.1', port: srv.address().port, agent }, (res) => {
        res.resume();
        res.on('end', () => ev.push(`response ${res.headers['keep-alive']}`));
      });
    });
  });

const again = () =>
  new Promise((resolve) => {
    const ev = [];
    const srv = http.createServer((req, res) => {
      if (req.url === '/1') srv.close(() => resolve(ev.concat('close cb').join(' | ')));
      res.end(req.url);
    });
    srv.keepAliveTimeout = 300;
    srv.listen(0, '127.0.0.1', () => {
      const c = net.connect(srv.address().port, '127.0.0.1', () => c.write('GET /1 HTTP/1.1\r\nHost: x\r\n\r\n'));
      let n = 0;
      c.on('data', (d) => {
        ev.push(`response ${++n} ${/connection: (\S+)/i.exec(String(d))?.[1]}`);
        if (n === 1) setTimeout(() => c.write('GET /2 HTTP/1.1\r\nHost: x\r\n\r\n'), 100);
      });
      c.on('close', () => ev.push('client sees close'));
    });
  });

(async () => {
  console.log('kept:', await kept());
  console.log('short hint:', await short());
  console.log('request after close():', await again());
})();
