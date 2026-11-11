import e from 'node:process';
const out = [];
function f() {
  class C {
    static {
      var e = 'block';
      out.push(['block', e]);
    }
    static {
      out.push(['sib', e === e && typeof e === 'object' ? 'import' : 'other']);
    }
    m() {
      return e === e && typeof e === 'object' ? 'import' : 'other';
    }
  }
  out.push(['method', new C().m()]);
  out.push(['fn', e === e && typeof e === 'object' ? 'import' : 'other']);
}
f();
for (const [label, value] of out) console.log('static-block-var', label, value);
