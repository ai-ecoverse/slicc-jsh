export default [
  { name: 'direct-term', cmd: 'rm -f /tmp/sk.*; node selfkill.js SIGTERM /tmp/sk; echo "rc=$?"; ls /tmp/sk.* 2>/dev/null || echo no-finally-file' },
  { name: 'direct-int', cmd: 'rm -f /tmp/si.*; node selfkill.js SIGINT /tmp/si; echo "rc=$?"; ls /tmp/si.* 2>/dev/null || echo no-finally-file' },
  { name: 'direct-kill', cmd: 'node selfkill.js SIGKILL /tmp/sx; echo "rc=$?"' },
  { name: 'handler', cmd: 'node -e "process.on(\'SIGTERM\', () => { console.log(\'handled\'); }); process.kill(process.pid, \'SIGTERM\'); setTimeout(() => console.log(\'alive\'), 50)"; echo "rc=$?"' },
  { name: 'parent', cmd: 'rm -f /tmp/skp-* /tmp/ska* /tmp/ske*; node parent.js 2>&1; ls /tmp/skp-* /tmp/ska* /tmp/ske* 2>/dev/null | wc -l' },
];
