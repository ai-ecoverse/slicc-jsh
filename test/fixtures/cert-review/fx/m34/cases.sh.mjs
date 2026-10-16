export default [
  { name: 'epipe-console', cmd: 'node -e "process.on(\'exit\', (c) => console.error(\'exit\', c)); for (let i = 0; i < 2000; i++) console.log(\'line \' + i)" | { read l; }; echo "rc=${PIPESTATUS[0]}"', timeout: 60000 },
  { name: 'epipe-console-slow', cmd: 'node -e "let i = 0; const t = setInterval(() => { console.log(\'x\' + i++); if (i > 50) clearInterval(t) }, 5)" 2>/dev/null | { read l; }; echo "rc=${PIPESTATUS[0]}"', timeout: 60000 },
  { name: 'epipe-console-stderr', cmd: 'node -e "for (let i = 0; i < 2000; i++) console.error(\'e\' + i)" 2>&1 >/dev/null | { read l; }; echo "rc=${PIPESTATUS[0]}"', timeout: 60000 },
  { name: 'sigpipe-listener-removed', cmd: 'node -e "const h = () => {}; process.on(\'SIGPIPE\', h); process.off(\'SIGPIPE\', h); setInterval(() => process.stdout.write(\'y\\n\'), 2)" | { read l; }; echo "rc=${PIPESTATUS[0]}"', timeout: 30000 },
  { name: 'sigpipe-listener-kept', cmd: 'node -e "process.on(\'SIGPIPE\', () => {}); let n = 0; const t = setInterval(() => { process.stdout.write(\'y\\n\'); if (++n > 30) { clearInterval(t); console.error(\'done\') } }, 2); process.stdout.on(\'error\', (e) => {})" | { read l; }; echo "rc=${PIPESTATUS[0]}"', timeout: 30000 },
  { name: 'sigpipe-removeAll', cmd: 'node -e "process.on(\'SIGPIPE\', () => {}); process.removeAllListeners(\'SIGPIPE\'); setInterval(() => process.stdout.write(\'y\\n\'), 2)" | { read l; }; echo "rc=${PIPESTATUS[0]}"', timeout: 30000 },
  { name: 'tick3', cmd: 'node tick3.js' },
  { name: 'fs-extra-cjs', cmd: 'node -e "const f = require(\'fs-extra\'); console.log(typeof f.ensureDirSync, typeof f.copy)"' },
  { name: 'constants-esm', cmd: 'node --input-type=module -e "import c, { O_RDONLY } from \'constants\'; console.log(typeof c, O_RDONLY)"' },
];
