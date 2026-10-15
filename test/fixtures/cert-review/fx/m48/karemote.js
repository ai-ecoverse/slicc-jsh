const https = require('https');
const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
const one = (l) => new Promise((r) => { const t = setTimeout(() => { console.log(l, 'stuck at 5s'); r(); }, 5000); https.get('https://registry.npmjs.org/-/ping', { agent }, (res) => { res.resume(); res.on('end', () => { clearTimeout(t); console.log(l, res.statusCode); r(); }); }).on('error', (e) => { clearTimeout(t); console.log(l, 'err', e.code); r(); }); });
(async () => { await one('r1'); await one('r2'); await one('r3'); agent.destroy(); })();
