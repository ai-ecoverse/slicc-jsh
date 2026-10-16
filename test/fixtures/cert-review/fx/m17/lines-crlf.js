const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const out = []; rl.on('line', (l) => out.push(JSON.stringify(l))); rl.on('close', () => console.log(out.join(' ')));
