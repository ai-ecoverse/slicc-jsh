const http = require('http'), net = require('net');
class ProxyAgent extends http.Agent {
  constructor(o) { super(o); }
  addRequest(req, options) { this.added = (this.added || 0) + 1; return super.addRequest(req, options); }
  createConnection(options, cb) { this.cc = (this.cc || 0) + 1; return net.createConnection({ port: options.port, host: options.host }, cb ? () => {} : undefined); }
}
const srv = http.createServer((q, s) => s.end('ok'));
srv.listen(0, '127.0.0.1', () => {
  const a = new ProxyAgent();
  const r = http.request({ host: '127.0.0.1', port: srv.address().port, agent: a }, (res) => { res.resume(); res.on('end', () => { console.log('status', res.statusCode, 'addRequest', a.added, 'createConnection', a.cc); srv.close(); }); });
  r.on('error', (e) => { console.log('error', e.code, e.message); srv.close(); });
  r.end();
});
