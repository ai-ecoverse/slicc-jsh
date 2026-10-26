await 1;
const e = new RangeError("a");
Object.defineProperty(e, "stack", { get() { throw 1 } });
throw e;
