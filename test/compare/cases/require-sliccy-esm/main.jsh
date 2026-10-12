const e = await import('sliccy:exec');
console.log(typeof e.default, typeof e.exec, typeof (e.default && e.default.spawn));
const c = await import('sliccy:cli');
console.log(typeof c.default.die, typeof c.die);
