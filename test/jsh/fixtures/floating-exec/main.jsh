const { exec } = require('sliccy:exec');
async function main() {
  const r = await exec.spawn(['node', '-e', 'setTimeout(() => console.log("child done"), 200)']);
  console.log('exec', r.exitCode, r.stdout.trim());
}
main().catch((e) => { console.error(e); process.exit(1); });
console.log('body returned');
