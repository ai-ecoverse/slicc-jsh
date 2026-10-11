const e = await import('esm-pkg');
console.log(e.default, e.hello());
const c = await import('cjs-pkg');
console.log(c.default.name, c.name);
