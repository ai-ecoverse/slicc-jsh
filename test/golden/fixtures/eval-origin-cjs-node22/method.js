const run = globalThis["ev" + "al"];
const o = { go(s) { return run(s); } };
try { o.go("null.m"); } catch (e) { console.log(e.stack); }
