const util = require('node:util');
const traps = [];
const handler = new Proxy({}, { get: (_, name) => { traps.push(String(name)); return undefined; } });
const obj = new Proxy({ a: 1, nested: { b: [1, 2] } }, handler);
const arr = new Proxy([1, 2, 3], {});
const fn = new Proxy(function named() {}, {});
const cls = new Proxy(class K {}, {});
const nested = new Proxy(new Proxy({ deep: true }, {}), {});
const { proxy: revoked, revoke } = Proxy.revocable({}, {});
revoke();
const map = new Proxy(new Map([[1, 2]]), {});
console.log(util.inspect(new Proxy(Promise.resolve(1), {})), util.inspect(new Proxy({ a: 1 }, {})));
console.log(obj, arr, fn, cls);
console.log(nested, revoked, map);
console.log({ inside: obj, list: [arr, nested] });
console.log(util.inspect(obj, { showProxy: true }), util.inspect(nested, { showProxy: true }), util.inspect(revoked, { showProxy: true }));
console.log(util.inspect(obj, { showProxy: true, depth: 0 }));
console.log(util.format('%o | %O | %s | %j', arr, obj, new Proxy({ s: 1 }, {}), new Proxy({ j: 1 }, {})));
console.log(util.inspect(obj, { colors: true }), util.inspect(revoked, { colors: true }));
console.log('traps', JSON.stringify(traps));
console.log(util.types.isProxy(obj), util.types.isProxy(nested), util.types.isProxy({}));
const custom = new Proxy({ [util.inspect.custom](depth, options) { return `custom ${depth} ${typeof options.stylize} ${this === custom}`; } }, {
  getPrototypeOf() { throw new Error('getPrototypeOf trap ran'); },
});
console.log(util.inspect(custom), [custom], util.inspect(custom, { customInspect: false }));
console.log(util.inspect(new Proxy({ [util.inspect.custom]: () => ({ swapped: true }) }, {})), util.inspect(custom, { showProxy: true }));
