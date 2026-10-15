const cp = require('child_process'); const fs = require('fs'); fs.mkdirSync('/tmp/m22c', { recursive: true }); const T = '/tmp/m22c'; const rd = (p) => JSON.stringify(fs.readFileSync(p, 'utf8'));
(async () => { let c;
  const ws = fs.createWriteStream(`${T}/ws.txt`); await new Promise((r) => ws.on('open', r));
  console.log('ws.fd', typeof ws.fd);
  try { c = cp.spawn('sh', ['-c', 'echo via-write-stream'], { stdio: ['ignore', ws, 'inherit'] }); await new Promise((r) => c.on('close', r)); } catch (e) { console.log('WriteStream stdio threw', e.code); }
  ws.end(); await new Promise((r) => ws.on('finish', r)); console.log('fs.WriteStream stdio', rd(`${T}/ws.txt`));
})();
