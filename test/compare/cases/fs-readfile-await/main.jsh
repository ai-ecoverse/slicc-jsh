const D=(v)=>{if(v===undefined)return'undefined';if(typeof v==='function')return'[function]';if(typeof v==='bigint')return`${v}n`;if(v&&typeof v.then==='function'){v.then(()=>{},()=>{});return'[Promise]'}if(typeof Buffer!=='undefined'&&Buffer.isBuffer&&Buffer.isBuffer(v))return`[Buffer ${v.length}]`;if(v instanceof Uint8Array)return`[Uint8Array ${v.length}]`;try{return JSON.stringify(v)}catch{return String(v)}},E=(e)=>`THROW ${e&&e.name}${e&&e.code?` ${e.code}`:''}: ${String(e&&e.message).split('\n')[0]}`,show=(k,f)=>{let s;try{s=D(f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)},showA=async(k,f)=>{let s;try{s=D(await f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)};
const fs = require('fs');
await showA('await fs.readFile(p)', async () => { const v = await fs.readFile('data.txt'); return [typeof v, String(v)]; });
await showA("await fs.readFile(p, 'utf8')", async () => await fs.readFile('data.txt', 'utf8'));
await showA("await fs.readFile(p, { encoding: 'utf8' })", async () => await fs.readFile('data.txt', { encoding: 'utf8' }));
await showA('await fs.readFile(missing)', async () => await fs.readFile('missing.txt'));
