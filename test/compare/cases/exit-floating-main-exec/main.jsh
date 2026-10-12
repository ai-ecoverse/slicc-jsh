const { exec } = require('sliccy:exec');
async function main() {
  const r = await exec('sleep 0.3; echo slept');
  console.log('exec', JSON.stringify(r.stdout));
}
main().catch((e) => { console.error('error:', e.message); process.exit(1); });
console.log('body returned');
