export default [
  { name: 'detach', cmd: 'node detach.js 2>&1; echo "rc=$?"', timeout: 60000 },
  { name: 'unref-outlives', cmd: 'rm -f /tmp/m43late; node unref.js /tmp/m43late; echo "rc=$?"; ls /tmp/m43late 2>/dev/null || echo "not yet"; sleep 7; cat /tmp/m43late 2>/dev/null || echo missing', timeout: 30000 },
];
