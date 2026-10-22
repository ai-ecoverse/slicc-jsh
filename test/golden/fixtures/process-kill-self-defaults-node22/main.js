const cp = require('child_process');

for (const sig of ['SIGUSR2', 'SIGALRM', 'SIGVTALRM', 'SIGXCPU', 'SIGSEGV', 'SIGPIPE', 'SIGURG', 'SIGCONT']) {
  const r = cp.spawnSync(process.execPath, ['-e', `process.on("exit", () => console.log("exit listener")); try { process.stdout.write("before\\n"); console.log("ret", process.kill(process.pid, "${sig}")); } finally { console.log("finally"); }`], { encoding: 'utf8' });
  console.log(sig, r.status, r.signal, JSON.stringify(r.stdout));
}
