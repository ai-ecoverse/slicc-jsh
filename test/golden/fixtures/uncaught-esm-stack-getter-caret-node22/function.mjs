function make() {
  return new TypeError("t");
}
const e = make();
Object.defineProperty(e, "stack", { get() { throw 1 } });
throw e;
