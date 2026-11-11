import e from 'node:process';
function outer() {
  for (let e of ['inner']) {
    function nested() {
      return e;
    }
    return nested();
  }
}
console.log('nested-shadow', outer(), typeof e === 'object' ? 'import-ok' : 'import-bad');
