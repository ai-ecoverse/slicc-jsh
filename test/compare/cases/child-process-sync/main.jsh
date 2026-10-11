const D=(v)=>{if(v===undefined)return'undefined';if(typeof v==='function')return'[function]';if(typeof v==='bigint')return`${v}n`;if(v&&typeof v.then==='function'){v.then(()=>{},()=>{});return'[Promise]'}if(typeof Buffer!=='undefined'&&Buffer.isBuffer&&Buffer.isBuffer(v))return`[Buffer ${v.length}]`;if(v instanceof Uint8Array)return`[Uint8Array ${v.length}]`;try{return JSON.stringify(v)}catch{return String(v)}},E=(e)=>`THROW ${e&&e.name}${e&&e.code?` ${e.code}`:''}: ${String(e&&e.message).split('\n')[0]}`,show=(k,f)=>{let s;try{s=D(f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)},showA=async(k,f)=>{let s;try{s=D(await f())}catch(e){s=E(e)}process.stdout.write(`${k}: ${s}\n`)};
const cp = require('child_process');
show('execSync string', () => cp.execSync('echo hi', { encoding: 'utf8' }));
show('execSync buffer', () => Buffer.isBuffer(cp.execSync('echo hi')));
show('execFileSync', () => cp.execFileSync('echo', ['a', 'b c'], { encoding: 'utf8' }));
show('spawnSync', () => { const r = cp.spawnSync('sh', ['-c', 'echo out; echo err >&2; exit 3'], { encoding: 'utf8' }); return [r.status, r.stdout, r.stderr]; });
show('execSync failing', () => { try { cp.execSync('exit 4', { stdio: 'pipe' }); return 'no throw'; } catch (e) { return [e.status, typeof e.stdout]; } });
show('execSync input', () => cp.execSync('cat', { input: 'piped in', encoding: 'utf8' }));
show('spawnSync missing', () => { const r = cp.spawnSync('no-such-cmd-xyz'); return [r.status, r.error && r.error.code]; });
