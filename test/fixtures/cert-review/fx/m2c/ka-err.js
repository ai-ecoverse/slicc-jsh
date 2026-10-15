const http = require('http');
const srv = http.createServer((req, res) => res.end('ok'));
srv.listen(0, '127.0.0.1', () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    http.get({ host: '127.0.0.1', port: srv.address().port, path: '/a', agent }, (res) => { res.resume(); res.on('end', () => { console.log('ok', res.statusCode, 'reusedSocket', res.req.reusedSocket); agent.destroy(); srv.close(); }); }).on('error', (e) => { console.log('req error', e.code, e.message); srv.close(); });
  } catch (e) { console.log('THREW', e.name, e.code, e.message); console.log(e.stack.split('\n').slice(0, 4).join(' | ')); srv.close(); }
});
