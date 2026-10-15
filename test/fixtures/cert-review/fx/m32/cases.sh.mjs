export default [
  { name: 'devsync-pipe', cmd: 'echo stdin-data | node devsync.js 2>&1' },
  { name: 'devsync-file', cmd: 'echo filedata > /tmp/fin; node devsync.js < /tmp/fin > /tmp/fout 2>&1; cat /tmp/fout' },
  { name: 'devasync', cmd: 'node devasync.js 2>&1' },
  { name: 'devchild', cmd: 'node devchild.js 2>&1' },
  { name: 'epipe-write', cmd: 'node epipe.js write | { read l; }; echo "rc=${PIPESTATUS[0]}"', timeout: 30000 },
  { name: 'epipe-console', cmd: 'node epipe.js console | { read l; }; echo "rc=${PIPESTATUS[0]}"', timeout: 60000 },
  { name: 'epipe-listener-removed', cmd: 'node epipe.js listener | { read l; }; echo "rc=${PIPESTATUS[0]}"', timeout: 30000 },
  { name: 'epipe-handled', cmd: 'node epipe.js handled | { read l; }; echo "rc=${PIPESTATUS[0]}"', timeout: 30000 },
  { name: 'epipe-handled-stderr', cmd: 'node epipe.js handled 2>&1 | { read l; }; echo "rc=${PIPESTATUS[0]}"', timeout: 30000 },
  { name: 'tick-uncaught-listener', cmd: 'node tick.js; echo rc=$?' },
  { name: 'tick-uncaught-report', cmd: 'node tick2.js 2>&1 | head -6; echo "rc=${PIPESTATUS[0]}"' },
  { name: 'chdir-empty', cmd: 'node -e "try { process.chdir(\'\') } catch (e) { console.log(e.code, e.errno, e.syscall) }"' },
];
