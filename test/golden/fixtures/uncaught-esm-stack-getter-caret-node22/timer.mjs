setTimeout(() => { const e = new Error("t"); Object.defineProperty(e, "stack", { get() { return null.s } }); throw e; });
