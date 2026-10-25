const o = {};
function f() {
  return o.a.b;
}
try { f(); } catch (e) { console.log(e.stack); }
