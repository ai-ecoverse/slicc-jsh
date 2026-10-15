const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'P> ' });
rl.prompt(); rl.on('line', (l) => { if (l === 'quit') return rl.close(); console.log('echo:' + l); rl.setPrompt('Q> '); rl.prompt(); });
rl.on('close', () => console.log('\nbye', rl.getPrompt()));
