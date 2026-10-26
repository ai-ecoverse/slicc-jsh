const e = Object.create(Error.prototype, { message: { value: "fake" } });
Object.defineProperty(e, "stack", { get() { throw 1 } });
throw e;
