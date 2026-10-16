const http = require('http'), { pipeline, PassThrough, Writable } = require('stream'), fs = require('fs');
fs.writeFileSync('/tmp/src.bin', Buffer.alloc(300000, 'z'));
const srv = http.createServer((req, res) => { if (req.url === '/file') { res.setHeader('content-type', 'application/octet-stream'); fs.createReadStream('/tmp/src.bin').pipe(res); } else { pipeline(req, new PassThrough(), res, (e) => e && console.log('server pipeline err', e.code)); } });
srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port; const get = (path) => new Promise((r) => http.get({ host: '127.0.0.1', port, path }, r));
  // res.pipe
  await new Promise((r) => get('/file').then((res) => { const w = fs.createWriteStream('/tmp/dst.bin'); res.pipe(w); w.on('finish', () => { console.log('res.pipe →', fs.statSync('/tmp/dst.bin').size); r(); }); }));
  // for await
  { const res = await get('/file'); let n = 0; for await (const c of res) n += c.length; console.log('for await →', n); }
  // setEncoding
  { const res = await get('/file'); res.setEncoding('latin1'); let s = ''; for await (const c of res) s += c; console.log('setEncoding typeof', typeof s, s.length, s.slice(0, 3)); }
  // listener attached after an await
  { const res = await get('/file'); await new Promise((r) => setTimeout(r, 100)); let n = 0; res.on('data', (c) => (n += c.length)); await new Promise((r) => res.on('end', r)); console.log('late listener →', n); }
  // stream.pipeline client → server echo
  await new Promise((r) => { const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/echo' }, (res) => { let n = 0; pipeline(res, new Writable({ write(c, e, cb) { n += c.length; cb(); } }), (e) => { console.log('pipeline echo →', e ? e.code : n); r(); }); }); pipeline(fs.createReadStream('/tmp/src.bin'), req, (e) => e && console.log('client pipeline err', e.code)); });
  srv.close();
});
