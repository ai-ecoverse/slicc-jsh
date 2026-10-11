const D=(v)=>{if(v===undefined)return'undefined';if(typeof v==='function')return'[function]';if(typeof v==='bigint')return`${v}n`;if(v&&typeof v.then==='function'){v.then(()=>{},()=>{});return'[Promise]'}if(typeof Buffer!=='undefined'&&Buffer.isBuffer&&Buffer.isBuffer(v))return`[Buffer ${v.length}]`;if(v instanceof Uint8Array)return`[Uint8Array ${v.length}]`;try{return JSON.stringify(v)}catch{return String(v)}},E=(e)=>`THROW ${e&&e.name}${e&&e.code?` ${e.code}`:''}: ${String(e&&e.message).split('\n')[0]}`,show=(k,f)=>{let s;try{s=D(f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)},showA=async(k,f)=>{let s;try{s=D(await f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)};
const fs = require('fs');
await showA('createWriteStream', () => new Promise((resolve, reject) => {
  const w = fs.createWriteStream('w.txt');
  w.on('error', reject);
  w.write('stream ');
  w.end('written', () => resolve(fs.readFileSync('w.txt', 'utf8')));
}));
await showA('createReadStream', () => new Promise((resolve, reject) => {
  let s = '';
  const r = fs.createReadStream('data.txt', { encoding: 'utf8' });
  r.on('data', (c) => { s += c; });
  r.on('end', () => resolve(s));
  r.on('error', reject);
}));
await showA('pipe', () => new Promise((resolve, reject) => {
  const out = fs.createWriteStream('copy.txt');
  out.on('finish', () => resolve(fs.readFileSync('copy.txt', 'utf8')));
  fs.createReadStream('data.txt').on('error', reject).pipe(out);
}));
