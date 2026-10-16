const https = require('https');
const get = (url, opts = {}) => new Promise((r) => { try { const req = https.get(url, opts, (res) => { let n = 0; res.on('data', (c) => (n += c.length)); res.on('end', () => r(`${res.statusCode} loc=${res.headers.location ?? '-'} ct=${(res.headers['content-type'] ?? '').split(';')[0]} bytes>0=${n > 0}`)); }); req.on('error', (e) => r(`error ${e.code} ${e.message.slice(0, 80)}`)); } catch (e) { r(`threw ${e.code} ${e.message.slice(0, 100)}`); } });
(async () => {
  console.log('200:', await get('https://registry.npmjs.org/@ai-ecoverse%2Fslicc-jsh'));
  console.log('302:', await get('https://github.com/ai-ecoverse/slicc-jsh/archive/refs/heads/main.zip'));
  console.log('ca option:', await get('https://registry.npmjs.org/', { ca: 'x' }));
  console.log('rejectUnauthorized:false:', await get('https://registry.npmjs.org/', { rejectUnauthorized: false }));
  console.log('cert option:', await get('https://registry.npmjs.org/', { cert: 'x', key: 'y' }));
  try { https.createServer({}); console.log('https.createServer: no throw'); } catch (e) { console.log('https.createServer:', e.code, e.message.slice(0, 80)); }
})();
