const e = new Function("return new Error(\"fn\")")();
Object.defineProperty(e, "stack", { get() { throw 1 } });
throw e;
