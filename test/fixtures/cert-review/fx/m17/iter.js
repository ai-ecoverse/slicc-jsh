const readline = require('readline');
(async () => { const rl = readline.createInterface({ input: process.stdin }); let n = 0, total = 0; for await (const l of rl) { n++; total += l.length; } console.log('lines', n, 'chars', total); })();
