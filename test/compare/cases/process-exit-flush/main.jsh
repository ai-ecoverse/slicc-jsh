const line = 'x'.repeat(99) + '\n';
for (let i = 0; i < 2000; i++) process.stdout.write(line);
console.error('stderr line');
process.exit(0);
