class Custom extends Error {}
const e = new Custom("sub"); Object.defineProperty(e, "stack", { get() { throw 1 } });
throw e;
