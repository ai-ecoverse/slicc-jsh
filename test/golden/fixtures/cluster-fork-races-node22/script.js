// cluster races against Node 22, each in a primary of its own (primary.js):
// - listen-then-disconnect: a worker disconnects while its listen() is
//   still being set up; it exits, as in Node.
// - close-during-setup: a worker closes its server before the primary has
//   set it up; the address is free again for the primary to listen on.
// - exclusive-relisten: a worker closes its shared server and listens again
//   with exclusive: true; address() is its own, and a connection reaches it.
// - relisten-during-setup: a worker closes its server before the primary has
//   set it up and listens again; the primary sees one 'listening'.
const { spawn } = require('child_process');
const path = require('path');
const run = (name) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(__dirname, 'primary.js'), name], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('close', (code) => {
      console.log(`${name}: ${out.trim().split('\n').join(' | ')} | primary ${code}`);
      resolve();
    });
  });
(async () => {
  await run('listen-then-disconnect');
  await run('close-during-setup');
  await run('exclusive-relisten');
  await run('relisten-during-setup');
})();
