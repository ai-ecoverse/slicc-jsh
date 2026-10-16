const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('name? ', (a) => { rl.question('age? ', (b) => { console.log(`\nanswers ${JSON.stringify(a)} ${JSON.stringify(b)}`); rl.close(); }); });
rl.on('close', () => console.log('closed'));
