setTimeout(() => console.log('timer after the body'), 30);
const t = setTimeout(() => console.log('unref timer never runs'), 5000);
t.unref();
console.log('body done');
