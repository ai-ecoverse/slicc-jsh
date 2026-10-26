const e = new Error("px");
Object.defineProperty(e, "stack", { get() { throw 1 } });
throw new Proxy(e, {});
