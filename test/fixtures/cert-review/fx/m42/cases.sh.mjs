export default [
  { name: 'bash-listener', cmd: 'node -e "require(\'http\').createServer((q,s)=>s.end(\'from-other-process\')).listen(47913,\'127.0.0.1\')" & P=$!; sleep 1.5; node -e "fetch(\'http://127.0.0.1:47913/\').then(r=>r.text()).then(t=>console.log(\'fetch\',t),e=>console.log(\'fetch ERR\',e.message,e.cause&&e.cause.code))"; curl -s http://127.0.0.1:47913/; echo; kill $P', timeout: 30000 },
];
