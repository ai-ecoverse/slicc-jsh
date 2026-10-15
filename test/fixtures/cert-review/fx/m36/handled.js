const sigs = process.argv.slice(2);
for (const s of sigs) process.on(s, (n) => console.log('listener', n));
for (const s of sigs) { const r = process.kill(process.pid, s); console.log('kill', s, 'returned', r); }
console.log('sync end');
Promise.resolve().then(() => console.log('microtask'));
setTimeout(() => console.log('timer'), 100);
