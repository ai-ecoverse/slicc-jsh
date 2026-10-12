process.nextTick(() => console.log('tick'));
await new Promise((resolve) => setTimeout(resolve, 20));
console.log('after await');
