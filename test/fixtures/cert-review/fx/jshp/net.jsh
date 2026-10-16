const http = require('sliccy:http');
const c = http.client({ baseUrl: 'https://registry.npmjs.org' });
const j = await c.get('/@ai-ecoverse%2Fslicc-jsh'); console.log('http json name', j.name, typeof j['dist-tags']);
try { await c.get('/@ai-ecoverse%2Fdefinitely-not-a-package-xyz'); } catch (e) { console.log('http error', e.name, e.status); }
const r = await fetch('https://registry.npmjs.org/-/ping').catch((e) => ({ status: 'ERR ' + e.message })); console.log('global fetch', r.status);
