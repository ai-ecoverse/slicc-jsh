setTimeout(() => { console.log('timer'); process.exit(5); }, 20);
setTimeout(() => console.log('never'), 2000);
console.log('body done');
