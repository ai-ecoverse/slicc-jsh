// node --expose-internals: ESM imports internal modules as require() does.
import utils from 'internal/readline/utils';
import * as ns from 'internal/readline/utils';

console.log('static default', typeof utils.CSI, typeof utils.emitKeys);
console.log('static keys', Object.keys(ns));
const dyn = await import('internal/readline/utils');
console.log('dynamic keys', Object.keys(dyn), dyn.default === utils);
const prefixed = await import('node:internal/readline/utils');
console.log('node: prefix', prefixed.default === utils);
console.log('import.meta.resolve', import.meta.resolve('internal/readline/utils'));
const { createRequire } = await import('node:module');
console.log('require same', createRequire(import.meta.url)('internal/readline/utils') === utils);
