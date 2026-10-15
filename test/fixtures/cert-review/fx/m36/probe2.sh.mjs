export default [
  { name: 'jc-node-int-e', cmd: 'exec 2>/dev/null; set -m; node -e "process.kill(process.pid, \'SIGINT\')"; echo "rc=$?"; echo next' },
  { name: 'jc-node-int-sk', cmd: 'exec 2>/dev/null; set -m; node sk.js pid SIGINT; echo "rc=$?"; echo next' },
  { name: 'jc-node-int-zero', cmd: 'exec 2>/dev/null; set -m; node sk.js zero SIGINT; echo "rc=$?"; echo next' },
  { name: 'jc-node-int-stdin-null', cmd: 'exec 2>/dev/null; set -m; node sk.js pid SIGINT < /dev/null; echo "rc=$?"; echo next' },
  { name: 'jc-ps', cmd: 'set -m; node -e "console.log(require(\'child_process\').execSync(\'ps -o pid,pgid,comm\').toString().split(\'\\n\').length > 1)"; echo "rc=$?"' },
  { name: 'jc-bash-int-then', cmd: 'exec 2>/dev/null; set -m; bash -c \'kill -INT $$\'; echo "rc=$?"; echo next' },
];
