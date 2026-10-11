const D=(v)=>{if(v===undefined)return'undefined';if(typeof v==='function')return'[function]';if(typeof v==='bigint')return`${v}n`;if(v&&typeof v.then==='function'){v.then(()=>{},()=>{});return'[Promise]'}if(typeof Buffer!=='undefined'&&Buffer.isBuffer&&Buffer.isBuffer(v))return`[Buffer ${v.length}]`;if(v instanceof Uint8Array)return`[Uint8Array ${v.length}]`;try{return JSON.stringify(v)}catch{return String(v)}},E=(e)=>`THROW ${e&&e.name}${e&&e.code?` ${e.code}`:''}: ${String(e&&e.message).split('\n')[0]}`,show=(k,f)=>{let s;try{s=D(f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)},showA=async(k,f)=>{let s;try{s=D(await f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)};
await showA('echo', () => new Promise((resolve, reject) => {
  const ws = new WebSocket(process.env.COMPARE_HTTP.replace('http', 'ws'));
  ws.onopen = () => ws.send('hi');
  ws.onmessage = (ev) => { ws.close(); resolve(String(ev.data)); };
  ws.onerror = (ev) => reject(new Error('ws error ' + (ev.message || '')));
  setTimeout(() => reject(new Error('ws timeout')), 5000);
}));
