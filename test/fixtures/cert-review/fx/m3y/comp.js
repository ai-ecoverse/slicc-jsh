import x from './one.js';
const o = { [x]: 1 }; const a = [x]; o[x] = 2;
console.log('computed', JSON.stringify(o), a[0]);
