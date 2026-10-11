const D=(v)=>{if(v===undefined)return'undefined';if(typeof v==='function')return'[function]';if(typeof v==='bigint')return`${v}n`;if(v&&typeof v.then==='function'){v.then(()=>{},()=>{});return'[Promise]'}if(typeof Buffer!=='undefined'&&Buffer.isBuffer&&Buffer.isBuffer(v))return`[Buffer ${v.length}]`;if(v instanceof Uint8Array)return`[Uint8Array ${v.length}]`;try{return JSON.stringify(v)}catch{return String(v)}},E=(e)=>`THROW ${e&&e.name}${e&&e.code?` ${e.code}`:''}: ${String(e&&e.message).split('\n')[0]}`,show=(k,f)=>{let s;try{s=D(f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)},showA=async(k,f)=>{let s;try{s=D(await f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)};
show('on SIGINT', () => { process.on('SIGINT', () => {}); return 'registered'; });
await showA('kill self SIGTERM', () => new Promise((resolve, reject) => {
  process.once('SIGTERM', () => resolve('handler ran'));
  try { process.kill(process.pid, 'SIGTERM'); } catch (e) { reject(e); }
  setTimeout(() => resolve('no signal within 500ms'), 500);
}));
process.removeAllListeners?.('SIGINT');
