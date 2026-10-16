const t0 = Date.now();
Promise.resolve().then(() => console.log('resolved'));
process.on('exit', () => console.error('elapsed<300', Date.now() - t0 < 300));
