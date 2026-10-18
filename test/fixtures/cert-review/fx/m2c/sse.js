// incremental response: the client sees each event before the server writes the next
const http = require('http');
let next;
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let i = 0;
  next = () => (i === 5 ? res.end() : res.write(`data: ${i++}\n\n`));
  next();
});
srv.listen(0, '127.0.0.1', () =>
  http.get({ host: '127.0.0.1', port: srv.address().port }, (res) => {
    const per = [];
    res.on('data', (c) => {
      per.push(c.toString().split('\n\n').filter(Boolean).length);
      next();
    });
    res.on('end', () => {
      console.log('events per chunk', per.join(' '), 'te', res.headers['transfer-encoding'], 'cl', res.headers['content-length']);
      srv.close();
    });
  })
);
