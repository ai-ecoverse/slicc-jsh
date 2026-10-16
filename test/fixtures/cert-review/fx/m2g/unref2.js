setTimeout(() => console.log('unref alone fired'), 50).unref();
const t = setTimeout(() => console.log('ref'), 100);
