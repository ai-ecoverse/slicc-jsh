#!/usr/bin/env node
// ES module frames, as Node prints them: file: URLs, the file's own
// lines and columns (a hashbang and imports included), no receiver at the
// top level, `Type.method` for method calls.
import { inHelper, thisOf } from './helper.mjs';
import path from 'node:path';

const base = new URL('./', import.meta.url).href;
const top = (e, n = 1) => e.stack.split('\n')[n].split(base).join('BASE/');

console.log(top(new Error('top')));
function foo() {
  return new Error('in foo');
}
console.log(top(foo()));
class K {
  m() {
    return new Error('m');
  }
  static s() {
    return new Error('s');
  }
}
console.log(top(new K().m()), '|', top(K.s()));
const o = { meth() { return new Error('o'); } };
console.log(top(o.meth()));
console.log(inHelper().split(base).join('BASE/'), typeof path.join);
try {
  null.x;
} catch (e) {
  console.log(e.message, top(e));
}
await 1;
console.log(top(new Error('after await')));
const sites = (() => {
  const prev = Error.prepareStackTrace;
  Error.prepareStackTrace = (_, s) => s;
  const s = new Error().stack;
  Error.prepareStackTrace = prev;
  return s;
})();
console.log('callsite', sites[0].getFileName().split(base).join('BASE/'), sites[0].getLineNumber(), sites[1].getFunctionName());
console.log("this in an imported function", thisOf(), thisOf`t`);
export const z = 1;
