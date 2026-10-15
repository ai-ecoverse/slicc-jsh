process.nextTick(() => console.log('tick during body'));
await new Promise((r) => setTimeout(r, 30));
console.log('after await');
