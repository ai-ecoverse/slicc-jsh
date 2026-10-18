const http = require('sliccy:http');
const registry = require('http').createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/@ai-ecoverse%2Fslicc-jsh') return res.end(JSON.stringify({ name: '@ai-ecoverse/slicc-jsh', 'dist-tags': { latest: '1.0.0' } }));
  if (req.url === '/-/ping') return res.end('{}');
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Not found' }));
});
await new Promise((r) => registry.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${registry.address().port}`;
const c = http.client({ baseUrl: base });
const j = await c.get('/@ai-ecoverse%2Fslicc-jsh'); console.log('http json name', j.name, typeof j['dist-tags']);
try { await c.get('/@ai-ecoverse%2Fdefinitely-not-a-package-xyz'); } catch (e) { console.log('http error', e.name, e.status); }
const r = await fetch(`${base}/-/ping`).catch((e) => ({ status: 'ERR ' + e.message })); console.log('global fetch', r.status);
registry.close();
