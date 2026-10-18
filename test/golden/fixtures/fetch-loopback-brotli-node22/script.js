// fetch() to a server of this program on the loopback, against host Node
// (undici): `content-encoding: br` bodies decoded (body.br is Node 22's
// encoding of the page; jsh has no encoder), coding lists, truncated and
// corrupt bodies, and what node:http's client leaves alone.
const http = require('http');
const zlib = require('zlib');
const body = Buffer.from('<p>' + 'brotli over http '.repeat(200) + '</p>');
const br = Buffer.from(require('fs').readFileSync(__dirname + '/body.br'));
const srv = http.createServer((req, res) => {
  const u = req.url;
  if (u === '/br') { res.writeHead(200, { 'content-encoding': 'br' }); return res.end(br); }
  if (u === '/BR') { res.writeHead(200, { 'content-encoding': 'BR' }); return res.end(br); }
  if (u === '/br-gzip') { res.writeHead(200, { 'content-encoding': 'br, gzip' }); return res.end(zlib.gzipSync(br)); }
  if (u === '/br-chunks') { res.writeHead(200, { 'content-encoding': 'br' }); res.write(br.subarray(0, 20)); setTimeout(() => res.end(br.subarray(20)), 20); return; }
  if (u === '/br-truncated') { res.writeHead(200, { 'content-encoding': 'br' }); return res.end(br.subarray(0, br.length - 5)); }
  if (u === '/br-corrupt') { res.writeHead(200, { 'content-encoding': 'br' }); return res.end(Buffer.from('not brotli at all')); }
  if (u === '/br-head') { res.writeHead(200, { 'content-encoding': 'br' }); return res.end(); }
  if (u === '/br-204') { res.writeHead(204, { 'content-encoding': 'br' }); return res.end(); }
  if (u === '/br-six') { res.writeHead(200, { 'content-encoding': 'br, br, br, br, br, br' }); return res.end(br); }
  if (u === '/br-unknown') { res.writeHead(200, { 'content-encoding': 'br, zz' }); return res.end(br); }
  res.writeHead(200); res.end(JSON.stringify(req.headers['accept-encoding']));
});
srv.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${srv.address().port}`;
  const show = async (l, p) => {
    try {
      const r = await p;
      const t = Buffer.from(await r.arrayBuffer());
      console.log(l, r.status, r.headers.get('content-encoding'), t.length, t.equals(body) ? 'body' : JSON.stringify(t.toString('latin1').slice(0, 40)));
    } catch (e) { console.log(l, 'THROWS', e.name, e.message, e.cause && `${e.cause.name} ${e.cause.code} ${e.cause.message}`); }
  };
  await show('accept-encoding', fetch(`${base}/ae`));
  await show('br', fetch(`${base}/br`));
  await show('BR', fetch(`${base}/BR`));
  await show('br, gzip', fetch(`${base}/br-gzip`));
  await show('br in chunks', fetch(`${base}/br-chunks`));
  await show('br truncated', fetch(`${base}/br-truncated`));
  await show('br corrupt', fetch(`${base}/br-corrupt`));
  await show('br HEAD', fetch(`${base}/br-head`, { method: 'HEAD' }));
  await show('br 204', fetch(`${base}/br-204`));
  await show('br, unknown', fetch(`${base}/br-unknown`));
  await show('too many codings', fetch(`${base}/br-six`));
  await new Promise((resolve) =>
    http.get(`${base}/br`, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        console.log('http.get', res.headers['content-encoding'], Buffer.concat(parts).equals(br));
        resolve();
      });
    })
  );
  srv.close();
});
