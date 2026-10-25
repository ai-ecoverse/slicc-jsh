const run = globalThis["ev" + "al"];
try { run("null.c"); } catch (e) { console.log(e.stack); }
