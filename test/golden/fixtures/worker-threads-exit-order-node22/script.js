// A Worker's 'exit' comes after every message the worker posted, even one
// from its own process 'exit' handler that comes together with its end, as
// in Node 22 (#662). one.js ten times, each its own program: the order
// mustn't depend on a race.
const { execFileSync } = require('child_process');
const path = require('path');
const orders = new Set();
for (let i = 0; i < 10; i++) {
  orders.add(String(execFileSync(process.execPath, [path.join(__dirname, 'one.js')])).trim().split('\n').join(' | '));
}
console.log([...orders].join('\n'));
