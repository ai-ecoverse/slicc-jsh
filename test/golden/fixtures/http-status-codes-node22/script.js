const http = require('http');
console.log(Object.keys(http.STATUS_CODES).length, JSON.stringify(http.STATUS_CODES));
const codes = [207, 418, 425, 451, 511, 299];
const server = http.createServer((req, res) => {
  res.statusCode = Number(req.url.slice(1));
  res.end();
});
server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  for (const code of codes) {
    await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${port}/${code}`, (res) => {
        console.log(code, JSON.stringify(res.statusMessage));
        res.resume();
        res.on('end', resolve);
      });
    });
  }
  server.close();
});
