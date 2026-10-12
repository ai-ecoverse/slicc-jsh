const log = [];
const done = new Promise((r) => setTimeout(r, 50));
Promise.resolve().then(() => log.push('microtask'));
try { process.nextTick(() => log.push('nextTick')); } catch (e) { log.push('nextTick throws: ' + e.message); }
setTimeout(() => log.push('timeout'), 0);
await done;
console.log(log.join(' '));
const t = setTimeout(() => {}, 1);
console.log('handle', typeof t, typeof t.unref, typeof t.ref, typeof t.hasRef, typeof t[Symbol.toPrimitive]);
clearTimeout(t);
console.log('setTimeout args', await new Promise((r) => setTimeout((a, b) => r(a + b), 1, 'x', 'y')));
