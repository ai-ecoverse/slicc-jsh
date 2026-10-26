const e = eval('new Error("ev")');
Object.defineProperty(e, "stack", { get() { throw 1 } });
throw e;
