const fs = require('fs');
const path = require('path');
const tls = require('tls');

const read = (name) => fs.readFileSync(path.join(__dirname, 'keys', name), 'utf8');
const own = { key: read('server.key'), cert: read('server.crt') };
const file = 'keys.log';
const LINE = /^([A-Z_0-9]+) ([0-9a-f]{64}) ([0-9a-f]+)$/;

process.on('warning', (w) => console.log(`warning: ${w.message}`));

const logged = () => {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'latin1') : '';
  return text.split('\n').filter(Boolean);
};

(async () => {
  const server = tls.createServer(own, (socket) => socket.end('hi'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => {
    const socket = tls.connect({ host: '127.0.0.1', port: server.address().port, rejectUnauthorized: false });
    socket.resume();
    socket.on('close', resolve);
  });
  server.close();
  const started = Date.now();
  while (logged().length < 10 && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 20));
  const lines = logged();
  const parsed = lines.map((l) => LINE.exec(l));
  console.log(`${lines.length} lines, NSS format ${parsed.every(Boolean)}`);
  console.log(parsed.map((m) => m?.[1]).sort().join(' '));
  console.log(`one client random: ${new Set(parsed.map((m) => m?.[2])).size === 1}`);
  console.log(`mode ${(fs.statSync(file).mode & 0o777).toString(8)}`);
  fs.unlinkSync(file);
})();
