const D=(v)=>{if(v===undefined)return'undefined';if(typeof v==='function')return'[function]';if(typeof v==='bigint')return`${v}n`;if(v&&typeof v.then==='function'){v.then(()=>{},()=>{});return'[Promise]'}if(typeof Buffer!=='undefined'&&Buffer.isBuffer&&Buffer.isBuffer(v))return`[Buffer ${v.length}]`;if(v instanceof Uint8Array)return`[Uint8Array ${v.length}]`;try{return JSON.stringify(v)}catch{return String(v)}},E=(e)=>`THROW ${e&&e.name}${e&&e.code?` ${e.code}`:''}: ${String(e&&e.message).split('\n')[0]}`,show=(k,f)=>{let s;try{s=D(f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)},showA=async(k,f)=>{let s;try{s=D(await f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)};
const net = require('net');
await showA('echo server', () => new Promise((resolve, reject) => {
  const server = net.createServer((sock) => sock.on('data', (d) => sock.end(`echo:${d}`)));
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const c = net.connect(server.address().port, '127.0.0.1', () => c.write('ping'));
    let s = '';
    c.on('data', (d) => { s += d; });
    c.on('end', () => { server.close(); resolve(s); });
    c.on('error', reject);
  });
}));
show('isIP', () => net.isIP('127.0.0.1'));
