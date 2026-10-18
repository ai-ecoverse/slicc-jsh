const net = require('net'), http = require('http');
const server = [];
const client = [];
let got = '';
let answered = false;
const srv = net.createServer((s) => {
  s.on('data', (d) => (got += d.toString('latin1')));
  s.on('end', () => server.push(`got FIN ${answered ? 'after' : 'before'} answering`));
  s.on('close', () => {
    srv.close();
    console.log('client:', client.join(' | '));
    console.log('server: request', JSON.stringify(got), got.length, '|', server.join(' | '));
  });
  setTimeout(() => {
    answered = true;
    s.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
  }, 1500);
});
srv.listen(0, '127.0.0.1', () => {
  const req = http.request({ host: '127.0.0.1', port: srv.address().port, method: 'POST', path: '/up' }, (res) => {
    res.resume();
    res.on('end', () => client.push(`done ${res.statusCode}`));
  });
  req.on('error', (e) => client.push(`error ${e.code}`));
  req.write('a'.repeat(10));
  setTimeout(() => {
    req.write('b'.repeat(20));
    req.end('c');
    client.push('end() called');
  }, 10);
});
