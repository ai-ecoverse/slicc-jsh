export default [
  { name: 'self-stop-bash', cmd: 'node stop.js & P=$!; sleep 1; echo "state: $(cat /proc/$P/stat 2>/dev/null | cut -d" " -f3 || ps -o stat= -p $P)"; kill -CONT $P; wait $P; echo "rc=$?"' },
  { name: 'self-stop-node-parent', cmd: 'node parent.js' },
];
