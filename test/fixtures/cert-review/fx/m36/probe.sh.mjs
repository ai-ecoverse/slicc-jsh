export default [
  { name: 'bash-self-int', cmd: 'exec 2>/dev/null; set -m; bash -c \'kill -INT $$; echo after\'; echo "rc=$?"' },
  { name: 'bash-self-int-nojc', cmd: 'exec 2>/dev/null; bash -c \'kill -INT $$; echo after\'; echo "rc=$?"' },
  { name: 'node-int-nojc', cmd: 'exec 2>/dev/null; node sk.js pid SIGINT; echo "rc=$?"' },
  { name: 'usr1-plain', cmd: 'node -e "console.log(\'kill USR1\', process.kill(process.pid, \'SIGUSR1\')); setTimeout(() => console.log(\'alive\'), 30)" 2>/dev/null; echo "rc=$?"' },
  { name: 'orphan-output', cmd: 'bash -c \'(sleep 0.1; echo orphan-said) & kill -TERM $$\' 2>/dev/null; echo "outer rc=$?"; sleep 0.5' },
];
