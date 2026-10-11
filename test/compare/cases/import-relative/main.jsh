const m = await import('./lib.mjs');
console.log(m.default, m.named);
const c = await import('./lib.cjs');
console.log(c.default.value, Object.keys(c).sort().join(','));
const sub = await import('./sub/x.mjs');
console.log(sub.where);
