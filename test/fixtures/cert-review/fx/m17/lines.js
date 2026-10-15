const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const ev = []; rl.on('line', (l) => ev.push('line:' + JSON.stringify(l))); rl.on('close', () => { ev.push('close'); console.log(ev.join('\n')); });
rl.on('pause', () => ev.push('pause')); rl.on('resume', () => ev.push('resume'));
console.log('terminal', rl.terminal, 'line', JSON.stringify(rl.line), typeof rl.getPrompt, rl.getPrompt());
