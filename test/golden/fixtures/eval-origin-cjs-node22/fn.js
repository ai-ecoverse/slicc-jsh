const run = globalThis["ev" + "al"];
function load(s) {
  return run(s);
}
try { load("\n  null.f"); } catch (e) { console.log(e.stack); }
