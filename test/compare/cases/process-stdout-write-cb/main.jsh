const t = setTimeout(() => { console.log('callback never called'); process.exit(3); }, 2000);
await new Promise((r) => process.stdout.write('x\n', r));
clearTimeout(t);
console.log('callback called');
