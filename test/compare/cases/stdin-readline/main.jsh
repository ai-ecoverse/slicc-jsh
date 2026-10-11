const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
for await (const line of rl) lines.push(line);
console.log(JSON.stringify(lines));
