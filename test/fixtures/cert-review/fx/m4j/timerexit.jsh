setTimeout(() => { console.log('timer exits 6'); process.exit(6); }, 50);
await new Promise(() => {});
