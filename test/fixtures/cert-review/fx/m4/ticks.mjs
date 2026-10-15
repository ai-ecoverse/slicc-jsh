process.nextTick(() => console.log('tick 1'));
queueMicrotask(() => console.log('micro 1'));
await new Promise((r) => setTimeout(r, 30));
process.nextTick(() => console.log('tick 2'));
await null;
console.log('after awaits');
