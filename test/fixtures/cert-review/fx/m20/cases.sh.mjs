const chk = (t) => `for s in catch finally after micro timer immediate tick sig asyncfinally exitlistener; do [ -e ${t}.$s ] && echo "$s: $(cat ${t}.$s)"; done; true`;
export default [
  { name: 'finally-side-effect', cmd: `rm -f /tmp/f1.*; node fin.js /tmp/f1; echo rc=$?; ${chk('/tmp/f1')}` },
  { name: 'finally-busy-timing', cmd: 's=$(node -p "Date.now()"); node finbusy.js; echo rc=$?; e=$(node -p "Date.now()"); [ $((e - s)) -lt 2500 ] && echo fast || echo "slow $((e - s)) ms"' },
  { name: 'async-after-exit', cmd: `rm -f /tmp/f2.*; node async.js /tmp/f2; echo rc=$?; sleep 0.3; ${chk('/tmp/f2')}` },
  { name: 'exit-listener-exitCode', cmd: `rm -f /tmp/f3.*; node listener.js /tmp/f3; echo rc=$?; ${chk('/tmp/f3')}` },
  { name: 'exit-in-listener', cmd: 'node listener2.js; echo rc=$?' },
  { name: 'flush-big-pipe', cmd: 'node flush.js 3000000 | (sleep 1; wc -c); echo "ps=${PIPESTATUS[0]}"' },
  { name: 'flush-big-file', cmd: 'node flush.js 3000000 > /tmp/fl.out; echo rc=$?; wc -c < /tmp/fl.out' },
  { name: 'flush-200-writes', cmd: 'node flush2.js | (sleep 0.5; tail -1; wc -l)' },
  { name: 'uncaught-listener-order', cmd: 'node uncaught.js 2>&1 | head -2; echo "ps=${PIPESTATUS[0]}"' },
  { name: 'uncaught-exit-in-listener', cmd: 'node uncaught2.js; echo rc=$?' },
  { name: 'self-kill-no-handler', cmd: 'node selfkill.js; echo rc=$?' },
];
