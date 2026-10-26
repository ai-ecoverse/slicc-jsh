try { require; console.log("no throw") } catch (x) { console.log(x.name, x.message) }
try { require("fs"); console.log("no throw2") } catch (x) { console.log(x.name, x.message) }
for (const n of ["module", "exports", "__filename", "__dirname"]) { try { eval(n); console.log(n, "no throw") } catch (x) { console.log(x.name, x.message) } }
console.log(typeof require, typeof module, "require" in globalThis, Object.getOwnPropertyNames(globalThis).filter((n) => ["require","module","exports","__filename","__dirname"].includes(n)))
