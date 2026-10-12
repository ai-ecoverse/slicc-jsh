setTimeout(() => process.exit(4), 20);
await new Promise((resolve) => setTimeout(resolve, 60000));
console.log('never');
