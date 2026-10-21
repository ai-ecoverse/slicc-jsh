const buffer = require('buffer');
const names = ['from', 'alloc', 'allocUnsafe', 'allocUnsafeSlow', 'concat', 'byteLength', 'isBuffer', 'isEncoding', 'compare'];
const enumerable = Object.keys(buffer.Buffer);
console.log(names.map((name) => `${name}:${enumerable.includes(name)}`).join(' '));
const Safer = {};
for (const key in buffer.Buffer) {
  if (!Object.prototype.hasOwnProperty.call(buffer.Buffer, key) || key === 'allocUnsafe' || key === 'allocUnsafeSlow') continue;
  Safer[key] = buffer.Buffer[key];
}
Safer.prototype = buffer.Buffer.prototype;
console.log(names.map((name) => `${name}:${typeof Safer[name]}`).join(' '));
const buf = Safer.from('caf\u00e9');
console.log(Safer.isBuffer(buf), Safer.byteLength('caf\u00e9'), Safer.concat([buf, Safer.alloc(2, 'a')]).toString(), Safer.isEncoding('latin1'), Safer.compare(buf, Safer.from('cafe')));
