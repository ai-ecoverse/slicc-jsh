setTimeout(() => console.log('never'), 30);
console.log('before');
await null;
throw new TypeError('boom');
