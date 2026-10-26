Error.prepareStackTrace = () => "custom";
const e = new Error("p");
Object.defineProperty(e, "stack", { get() { throw 1 } });
throw e;
