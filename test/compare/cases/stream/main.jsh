const D=(v)=>{if(v===undefined)return'undefined';if(typeof v==='function')return'[function]';if(typeof v==='bigint')return`${v}n`;if(v&&typeof v.then==='function'){v.then(()=>{},()=>{});return'[Promise]'}if(typeof Buffer!=='undefined'&&Buffer.isBuffer&&Buffer.isBuffer(v))return`[Buffer ${v.length}]`;if(v instanceof Uint8Array)return`[Uint8Array ${v.length}]`;try{return JSON.stringify(v)}catch{return String(v)}},E=(e)=>`THROW ${e&&e.name}${e&&e.code?` ${e.code}`:''}: ${String(e&&e.message).split('\n')[0]}`,show=(k,f)=>{let s;try{s=D(f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)},showA=async(k,f)=>{let s;try{s=D(await f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)};
const { Readable, Writable, Transform, PassThrough, pipeline } = require('stream');
await showA('Readable.from + for await', async () => { const out = []; for await (const c of Readable.from(['a', 'b'])) out.push(c); return out; });
await showA('pipeline (stream/promises)', async () => {
  const { pipeline: p } = require('stream/promises');
  const chunks = [];
  await p(Readable.from(['x', 'y']), new Transform({ transform(c, e, cb) { cb(null, String(c).toUpperCase()); } }), new Writable({ write(c, e, cb) { chunks.push(String(c)); cb(); } }));
  return chunks;
});
await showA('pipeline callback', () => new Promise((r) => pipeline(Readable.from(['q']), new PassThrough(), new Writable({ write(c, e, cb) { cb(); } }), (err) => r(err === undefined ? 'undefined' : err))));
show('Readable is EventEmitter', () => new Readable({ read() {} }) instanceof require('events'));
await showA('readable.read() paused mode', () => new Promise((r) => { const rs = new Readable({ read() {} }); rs.push('p'); rs.push(null); rs.once('readable', () => r(String(rs.read()))); }));
show('stream/web', () => typeof require('stream/web').ReadableStream);
show('Readable.toWeb', () => typeof Readable.toWeb);
