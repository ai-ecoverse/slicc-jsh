const p = Promise.reject(new Error('handled late'));
await new Promise((r) => setTimeout(r, 0));
p.catch((e) => console.log('caught', e.message));
await new Promise((r) => setTimeout(r, 20));
console.log('done');
