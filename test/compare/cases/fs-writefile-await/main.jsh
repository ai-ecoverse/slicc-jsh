const D=(v)=>{if(v===undefined)return'undefined';if(typeof v==='function')return'[function]';if(typeof v==='bigint')return`${v}n`;if(v&&typeof v.then==='function'){v.then(()=>{},()=>{});return'[Promise]'}if(typeof Buffer!=='undefined'&&Buffer.isBuffer&&Buffer.isBuffer(v))return`[Buffer ${v.length}]`;if(v instanceof Uint8Array)return`[Uint8Array ${v.length}]`;try{return JSON.stringify(v)}catch{return String(v)}},E=(e)=>`THROW ${e&&e.name}${e&&e.code?` ${e.code}`:''}: ${String(e&&e.message).split('\n')[0]}`,show=(k,f)=>{let s;try{s=D(f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)},showA=async(k,f)=>{let s;try{s=D(await f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)};
const fs = require('fs');
await showA('await fs.writeFile', async () => await fs.writeFile('out.txt', 'written\n'));
show('readFileSync after', () => (fs.existsSync('out.txt') ? fs.readFileSync('out.txt', 'utf8') : 'not written'));
await showA('await fs.mkdir recursive', async () => await fs.mkdir('m/n', { recursive: true }));
await showA('await fs.readdir', async () => await fs.readdir('dir'));
await showA('await fs.appendFile', async () => await fs.appendFile('out.txt', 'more\n'));
await showA('await fs.rm', async () => await fs.rm('m', { recursive: true }));
show('m exists', () => fs.existsSync('m'));
