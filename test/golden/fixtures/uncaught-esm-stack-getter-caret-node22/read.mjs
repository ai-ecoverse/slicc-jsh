const e = new Error("r");
e.stack;
Object.defineProperty(e, "stack", { get() { throw 1 } });
throw e;
