const run = globalThis["ev" + "al"];
try { run("const r = globalThis[\"ev\" + \"al\"];\nr(\"null.n\")"); } catch (e) { console.log(e.stack); }
