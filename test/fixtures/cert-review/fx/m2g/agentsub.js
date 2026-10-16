const http = require('http'), net = require('net');
class MyAgent extends http.Agent {
  constructor(o) { super(o); this.made = 0; }
  createConnection(options, cb) { this.made++; const s = net.connect(options.port, options.host); if (cb) s.once('connect', () => cb(null, s)); return s; }
}
const srv = http.createServer((q, s) => s.end('sub ' + q.url));
srv.listen(0, '127.0.0.1', () => {
  const agent = new MyAgent({ keepAlive: false });
  http.get({ host: '127.0.0.1', port: srv.address().port, path: '/x', agent }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { console.log('status', res.statusCode, b, 'createConnection called', agent.made, 'instanceof', agent instanceof http.Agent); agent.destroy(); srv.close(); });
  }).on('error', (e) => { console.log('error', e.code, e.message); srv.close(); });
});
