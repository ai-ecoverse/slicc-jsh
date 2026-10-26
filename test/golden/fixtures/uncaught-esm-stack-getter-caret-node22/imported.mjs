import { make } from "./lib.mjs";
const e = make();
Object.defineProperty(e, "stack", { get() { throw 1 } });
throw e;
