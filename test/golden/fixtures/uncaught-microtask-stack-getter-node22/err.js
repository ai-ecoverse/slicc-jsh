const e = new Error("x");
Object.defineProperty(e, "stack", { get() { return null.s; } });
throw e;
