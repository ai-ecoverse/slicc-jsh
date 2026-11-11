import e from 'node:process';
function f() {
  function g() {
    var e = 9;
    return e;
  }
  return [g(), e === e ? 'import-ok' : 'import-bad'];
}
console.log('nested-fn-var', f().join(' '));
