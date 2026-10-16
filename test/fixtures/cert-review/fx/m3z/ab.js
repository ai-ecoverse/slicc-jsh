const http = require('http'), net = require('net');
const { Agent } = require('agent-base');
class MyAgent extends Agent {
  connect(req, opts) { this.calls = (this.calls || 0) + 1; return net.connect({ host: opts.host, port: opts.port }); }
}
const srv = http.createServer((q, s) => s.end('via agent-base ' + q.url));
srv.listen(0, '127.0.0.1', () => {
  const agent = new MyAgent();
  http.get({ host: '127.0.0.1', port: srv.address().port, path: '/ab', agent }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { console.log(res.statusCode, b, 'connect() calls', agent.calls); srv.close(); });
  }).on('error', (e) => { console.log('error', e.code, e.message); srv.close(); });
});
