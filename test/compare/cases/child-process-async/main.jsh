const D=(v)=>{if(v===undefined)return'undefined';if(typeof v==='function')return'[function]';if(typeof v==='bigint')return`${v}n`;if(v&&typeof v.then==='function'){v.then(()=>{},()=>{});return'[Promise]'}if(typeof Buffer!=='undefined'&&Buffer.isBuffer&&Buffer.isBuffer(v))return`[Buffer ${v.length}]`;if(v instanceof Uint8Array)return`[Uint8Array ${v.length}]`;try{return JSON.stringify(v)}catch{return String(v)}},E=(e)=>`THROW ${e&&e.name}${e&&e.code?` ${e.code}`:''}: ${String(e&&e.message).split('\n')[0]}`,show=(k,f)=>{let s;try{s=D(f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)},showA=async(k,f)=>{let s;try{s=D(await f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)};
const cp = require('child_process');
const { promisify } = require('util');
await showA('exec cb', () => new Promise((r) => cp.exec('echo cb', (err, stdout, stderr) => r([err, stdout, stderr]))));
await showA('promisify(exec)', async () => { const { stdout } = await promisify(cp.exec)('echo promised'); return stdout; });
await showA('spawn', () => new Promise((r) => {
  const c = cp.spawn('sh', ['-c', 'echo spawned; exit 2']);
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.on('close', (code) => r([code, out]));
}));
await showA('execFile', () => new Promise((r) => cp.execFile('echo', ['ef'], (err, stdout) => r([err, stdout]))));
await showA('exec failing', () => new Promise((r) => cp.exec('exit 5', (err) => r([err && err.code, err && err.constructor.name]))));
await showA('spawn stdin', () => new Promise((r) => {
  const c = cp.spawn('cat');
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.on('close', (code) => r([code, out]));
  c.stdin.end('to cat');
}));
