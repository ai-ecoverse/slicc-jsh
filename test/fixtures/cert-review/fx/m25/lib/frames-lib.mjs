
export function thrower() {
  throw new Error('from lib');
}
export class Klass {
  method() { throw new TypeError('in method'); }
}
export function whoThis() { return typeof this; }
