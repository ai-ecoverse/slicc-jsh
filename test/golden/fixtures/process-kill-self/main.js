const cp = require('child_process');

const run = (label, src, show = (r) => [JSON.stringify(r.stdout), JSON.stringify(r.stderr)]) => {
  const r = cp.spawnSync(process.execPath, ['-e', src], { encoding: 'utf8' });
  console.log(label, r.status, r.signal, ...show(r));
};
const noStderr = (r) => [JSON.stringify(r.stdout)];

const after = 'process.on("exit", () => console.log("exit listener")); Promise.resolve().then(() => console.log("microtask")); setTimeout(() => console.log("timer"));';
for (const sig of ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGQUIT']) {
  run(`kill(self, ${sig})`, `${after} try { process.stdout.write("before\\n"); process.kill(process.pid, "${sig}"); console.log("after"); } finally { console.log("finally"); }`);
}
run('kill(self, 15)', 'try { process.kill(process.pid, 15); } finally { console.log("finally"); }');
// process.abort(): Node also prints a native stack trace on stderr.
run('abort()', `${after} process.on("SIGABRT", () => console.log("listener")); try { process.stdout.write("before\\n"); process.abort(); } finally { console.log("finally"); }`, noStderr);
run('kill(self, SIGABRT)', 'try { process.kill(process.pid, "SIGABRT"); } finally { console.log("finally"); }', noStderr);

// A handled signal returns at once; its listener runs later.
run('handled SIGUSR2', 'process.on("SIGUSR2", (s, n) => console.log("handler", s, typeof n)); console.log("ret", process.kill(process.pid, "SIGUSR2")); console.log("sync after"); setTimeout(() => console.log("end"), 100);');
run('handled SIGTERM', 'process.once("SIGTERM", () => { console.log("caught"); setTimeout(() => process.kill(process.pid, "SIGTERM"), 10); }); process.kill(process.pid, "SIGTERM"); console.log("still here"); setTimeout(() => console.log("not reached"), 1000);');
run('ignored by default', 'console.log(process.kill(process.pid, "SIGWINCH"), process.kill(process.pid, "SIGCHLD"), process.kill(process.pid, 0)); console.log("alive")');

// Other pids
run('no such pid', 'try { process.kill(999999, "SIGTERM"); } catch (e) { console.log(e.code, e.errno, e.syscall, e.message); }');
run('no such pid, sig 0', 'try { process.kill(999999, 0); } catch (e) { console.log(e.code, e.message); }');
run('a child', 'const c = require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" }); c.on("spawn", () => { console.log("ret", process.kill(c.pid, 0), process.kill(c.pid, "SIGTERM")); }); c.on("exit", (code, sig) => console.log("child", code, sig));');
