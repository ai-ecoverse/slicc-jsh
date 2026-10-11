const D=(v)=>{if(v===undefined)return'undefined';if(typeof v==='function')return'[function]';if(typeof v==='bigint')return`${v}n`;if(v&&typeof v.then==='function'){v.then(()=>{},()=>{});return'[Promise]'}if(typeof Buffer!=='undefined'&&Buffer.isBuffer&&Buffer.isBuffer(v))return`[Buffer ${v.length}]`;if(v instanceof Uint8Array)return`[Uint8Array ${v.length}]`;try{return JSON.stringify(v)}catch{return String(v)}},E=(e)=>`THROW ${e&&e.name}${e&&e.code?` ${e.code}`:''}: ${String(e&&e.message).split('\n')[0]}`,show=(k,f)=>{let s;try{s=D(f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)},showA=async(k,f)=>{let s;try{s=D(await f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)};
const http = require('http');
await showA('server + get', () => new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/plain'); res.end(`served ${req.method} ${req.url}`); });
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    http.get(`http://127.0.0.1:${port}/path?q=1`, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { s += d; });
      res.on('end', () => { server.close(); resolve([res.statusCode, res.headers['content-type'], s]); });
    }).on('error', reject);
  });
}));
await showA('http.get the compare server', () => new Promise((resolve, reject) => {
  http.get(`${process.env.COMPARE_HTTP}/json`, (res) => {
    let s = '';
    res.on('data', (d) => { s += d; });
    res.on('end', () => resolve([res.statusCode, s]));
  }).on('error', reject);
}));
show('https.request', () => typeof require('https').request);
show('STATUS_CODES', () => require('http').STATUS_CODES[404]);
