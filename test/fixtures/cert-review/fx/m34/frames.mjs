import { join } from 'node:path';
import { readFileSync } from 'node:fs';
function f() { return new Error('here').stack.split('\n')[1].replace(/\(.*\//, '(').trim(); }
const g = () => { const p = join('a', 'b'); return [p, f()]; };
console.log(g());
try { readFileSync('/nope/' + join('x')); } catch (e) { console.log(e.code); }
const e2 = new Error('col'); console.log(e2.stack.split('\n')[1].replace(/file:\/\/.*\//, '').trim());
      const e3 = join('q') && new Error('indented'); console.log(e3.stack.split('\n')[1].replace(/file:\/\/.*\//, '').trim());
