export default [
  { name: 'uncaught-listener', cmd: 'node uncaught.js listener; echo rc=$?' },
  { name: 'uncaught-capture', cmd: 'node uncaught.js capture; echo rc=$?' },
  { name: 'exit-128n', cmd: 'node -e "const cp=require(\'child_process\'); for (const c of [\'exit 143\',\'exit 130\',\'kill -TERM \\$\\$\']) { const r=cp.spawnSync(\'sh\',[\'-c\',c]); console.log(c, r.status, r.signal) } const k=cp.spawn(\'sh\',[\'-c\',\'exit 137\']); k.on(\'exit\',(c,s)=>console.log(\'async exit 137\', c, s)); cp.exec(\'exit 129\',(e)=>console.log(\'exec 129\', e.code, e.signal))"' },
  { name: 'debuglog', cmd: 'NODE_DEBUG=certtest node -e "require(\'util\').debuglog(\'certtest\')(\'hello %d\', 5)" 2>&1 | head -2' },
];
