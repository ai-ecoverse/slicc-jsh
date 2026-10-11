const D=(v)=>{if(v===undefined)return'undefined';if(typeof v==='function')return'[function]';if(typeof v==='bigint')return`${v}n`;if(v&&typeof v.then==='function'){v.then(()=>{},()=>{});return'[Promise]'}if(typeof Buffer!=='undefined'&&Buffer.isBuffer&&Buffer.isBuffer(v))return`[Buffer ${v.length}]`;if(v instanceof Uint8Array)return`[Uint8Array ${v.length}]`;try{return JSON.stringify(v)}catch{return String(v)}},E=(e)=>`THROW ${e&&e.name}${e&&e.code?` ${e.code}`:''}: ${String(e&&e.message).split('\n')[0]}`,show=(k,f)=>{let s;try{s=D(f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)},showA=async(k,f)=>{let s;try{s=D(await f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)};
const fs = require('fs');
const { exec } = require('sliccy:exec');
await showA('promises write → readFileSync', async () => { await fs.promises.writeFile('a.txt', 'from promises'); return fs.readFileSync('a.txt', 'utf8'); });
await showA('writeFileSync → promises read', async () => { fs.writeFileSync('b.txt', 'from sync'); return fs.promises.readFile('b.txt', 'utf8'); });
await showA('writeFileSync → exec cat', async () => { fs.writeFileSync('c.txt', 'seen by cat'); return (await exec('cat c.txt')).stdout; });
await showA('exec write → readFileSync', async () => { await exec('echo from-shell > d.txt'); return fs.readFileSync('d.txt', 'utf8'); });
await showA('exec write → existsSync', async () => { await exec('echo x > e.txt'); return fs.existsSync('e.txt'); });
