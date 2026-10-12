setTimeout(() => { throw new Error('late boom'); }, 20);
setTimeout(() => console.log('second timer (Node: never)'), 200);
console.log('body done');
