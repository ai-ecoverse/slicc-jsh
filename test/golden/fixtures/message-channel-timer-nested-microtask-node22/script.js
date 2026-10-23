const busy = (ms) => { const t = Date.now(); while (Date.now() - t < ms); };
const nest = (depth, fn) => (depth === 0 ? fn() : queueMicrotask(() => nest(depth - 1, fn)));
const rows = [
  ['posted by the timer', (send) => send()],
  ["posted by the timer's microtask", (send) => nest(1, send)],
  ['posted two microtasks down', (send) => nest(2, send)],
  ['posted three microtasks down', (send) => nest(3, send)],
  ['posted after an await', (send) => (async () => { await null; send(); })()],
  ['posted after two awaits', (send) => (async () => { await null; await null; send(); })()],
  ['posted from a then', (send) => Promise.resolve().then(() => 0).then(send)],
];
const which = process.argv[2];
if (which === undefined) {
  const { execFileSync } = require('child_process');
  for (let i = 0; i < rows.length; i++) process.stdout.write(execFileSync(process.execPath, [__filename, String(i)]));
} else {
  const [name, post] = rows[Number(which)];
  const L = [];
  const { port1, port2 } = new MessageChannel();
  port2.onmessage = (e) => L.push('mc ' + e.data);
  setTimeout(() => {
    post(() => port1.postMessage('x'));
    setTimeout(() => L.push('timer 0'), 0);
    busy(5);
  }, 1);
  setTimeout(() => {
    console.log(name + ':', L.join(' | '));
    port1.close();
  }, 200);
}
