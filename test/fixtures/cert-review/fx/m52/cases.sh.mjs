const r = (n, cmd) => ({ name: n, cmd });
export default [
  r('trace-sigint', 'node --trace-sigint -e "console.log(\'ts ok\')"; echo "rc=$?"'),
  r('nodeopts-eval', 'NODE_OPTIONS="--eval=1" node -e 0 2>&1; echo "rc=$?"'),
  r('umask-022', 'umask 022; node -p "process.umask().toString(8)"'),
  r('umask-077', 'umask 077; node -p "process.umask().toString(8)"'),
  r('umask-077-create', 'umask 077; rm -rf /tmp/m52u; node -e "const fs=require(\'fs\'); fs.mkdirSync(\'/tmp/m52u\'); fs.writeFileSync(\'/tmp/m52u/f\',\'x\')"; stat -c "%a" /tmp/m52u /tmp/m52u/f; rm -rf /tmp/m52u'),
  r('path-search-exec', 'node -e "require(\'child_process\').execFile(\'echo\', [\'pe-ok\'], (e, o) => console.log(e ? e.code : o.trim()))"'),
];
