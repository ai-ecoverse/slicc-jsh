import e from 'node:process';
function f(x = e) {
  var e = 1;
  return x === e ? 'body-var' : typeof x === 'object' ? 'import' : 'other';
}
console.log('default-param', f());
