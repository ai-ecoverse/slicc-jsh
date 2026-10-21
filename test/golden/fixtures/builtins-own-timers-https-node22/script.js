const https = require('https');
const net = require('net');
for (const name of ['setImmediate', 'setTimeout', 'setInterval', 'clearImmediate', 'clearTimeout', 'clearInterval']) {
  globalThis[name] = undefined;
}
const server = net.createServer().listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  server.close(() => {
    const req = https.request({ host: '127.0.0.1', port });
    req.setTimeout(10000);
    req.on('error', (err) => console.log('https error', err.code));
    req.end();
  });
});
process.on('exit', () => console.log('the program ends'));
