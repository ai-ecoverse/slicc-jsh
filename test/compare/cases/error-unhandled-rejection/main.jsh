Promise.reject(new Error('unhandled'));
await new Promise((r) => setTimeout(r, 100));
console.log('after 100ms (Node: never)');
