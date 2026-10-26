await 1;
const e = new Error("ra");
e.stack;
Object.defineProperty(e, "stack", { get() { throw 1 } });
throw e;
