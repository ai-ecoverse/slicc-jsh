import fs, { readFileSync } from 'node:fs';
import path from 'node:path';
class A {
  fs = typeof fs.readFileSync;
  path = 'field';
  static readFileSync = 'static field';
  accessor = 1;
  ['fs'] = 'computed';
  fs2 = fs === fs;
  meta = typeof import.meta.url;
  method() { return [this.fs, this.path, A.readFileSync, readFileSync === fs.readFileSync, path.sep]; }
}
const a = new A();
console.log(JSON.stringify(a.method()), a.fs2, a.meta, a.accessor, Object.keys(a).join());
