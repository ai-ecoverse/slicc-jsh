const cp = require('child_process'); const fs = require('fs');
const headc = 'let n = 0; process.stdin.on("data", (d) => { n += d.length; if (n >= 300000) { console.log("read", n >= 300000, d[0]); process.exit(0); } });';
// /dev/zero as stdin (endless): child reads what it wants
let z = fs.openSync('/dev/zero', 'r');
let r = cp.spawnSync('node', ['-e', headc], { stdio: [z, 'pipe', 'pipe'], encoding: 'utf8' });
console.log('sync /dev/zero stdin', r.status, JSON.stringify(r.stdout), r.error && r.error.code);
// /dev/null as output: 5 MB discarded
const nul = fs.openSync('/dev/null', 'w');
r = cp.spawnSync('node', ['-e', 'process.stdout.write("x".repeat(5000000)); console.error("done")'], { stdio: ['ignore', nul, 'pipe'], encoding: 'utf8' });
console.log('sync /dev/null out', r.status, JSON.stringify(r.stderr), r.error && r.error.code);
// /dev/null as stdin: EOF at once
const nulr = fs.openSync('/dev/null', 'r');
r = cp.spawnSync('node', ['-e', 'let n=0; process.stdin.on("data",d=>n+=d.length).on("end",()=>console.log("eof", n))'], { stdio: [nulr, 'pipe', 'pipe'], encoding: 'utf8' });
console.log('sync /dev/null in', r.status, JSON.stringify(r.stdout));
// async
const c = cp.spawn('node', ['-e', headc], { stdio: [z, 'pipe', 'inherit'] });
let o = ''; c.stdout.on('data', (d) => (o += d));
c.on('close', (code) => {
  console.log('async /dev/zero stdin', code, JSON.stringify(o));
  const d = cp.spawn('node', ['-e', 'process.stdout.write("x".repeat(5000000)); console.error("done")'], { stdio: ['ignore', nul, 'pipe'] });
  let e = ''; d.stderr.on('data', (x) => (e += x));
  d.on('close', (code2) => {
    console.log('async /dev/null out', code2, JSON.stringify(e));
    // closed right after spawn(): still works
    const z2 = fs.openSync('/dev/zero', 'r');
    const c3 = cp.spawn('node', ['-e', 'process.stdin.once("data", (d) => { console.log("got", d.length > 0); process.exit(0); })'], { stdio: [z2, 'pipe', 'inherit'] });
    fs.closeSync(z2);
    let o3 = ''; c3.stdout.on('data', (x) => (o3 += x));
    c3.on('close', (code3) => { console.log('async closed after spawn', code3, JSON.stringify(o3)); fs.closeSync(z); fs.closeSync(nul); fs.closeSync(nulr); });
  });
});
