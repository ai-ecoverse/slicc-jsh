const D=(v)=>{if(v===undefined)return'undefined';if(typeof v==='function')return'[function]';if(typeof v==='bigint')return`${v}n`;if(v&&typeof v.then==='function'){v.then(()=>{},()=>{});return'[Promise]'}if(typeof Buffer!=='undefined'&&Buffer.isBuffer&&Buffer.isBuffer(v))return`[Buffer ${v.length}]`;if(v instanceof Uint8Array)return`[Uint8Array ${v.length}]`;try{return JSON.stringify(v)}catch{return String(v)}},E=(e)=>`THROW ${e&&e.name}${e&&e.code?` ${e.code}`:''}: ${String(e&&e.message).split('\n')[0]}`,show=(k,f)=>{let s;try{s=D(f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)},showA=async(k,f)=>{let s;try{s=D(await f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)};
const fs = require('fs');
show('writeSync(1)', () => fs.writeSync(1, 'to fd 1\n'));
show('writeSync(2)', () => fs.writeSync(2, 'to fd 2\n'));
show('writeFileSync(1)', () => fs.writeFileSync(1, 'writeFileSync fd 1\n'));
show('openSync/readSync', () => { const fd = fs.openSync('data.txt', 'r'); const b = Buffer.alloc(5); const n = fs.readSync(fd, b, 0, 5, 0); fs.closeSync(fd); return [n, b.toString()]; });
show('openSync w + writeSync', () => { const fd = fs.openSync('fd.txt', 'w'); fs.writeSync(fd, 'via fd'); fs.closeSync(fd); return fs.readFileSync('fd.txt', 'utf8'); });
show('/dev/stdout', () => fs.writeFileSync('/dev/stdout', 'to /dev/stdout\n'));
show('/dev/null', () => fs.writeFileSync('/dev/null', 'gone'));
