const fs = require('fs');
console.log('stdin', JSON.stringify(fs.readFileSync(0, 'utf8')));
const ret = process.stdout.write('plain\n', () => console.log('write callback'));
console.log('returned', ret);
for (const v of [42, null, {}, undefined]) {
  try {
    process.stdout.write(v);
    console.log('no throw', v);
  } catch (e) {
    console.log('throw', e.name, e.code, e.message);
  }
}
process.stdout.write(Buffer.from('a buffer\n'));
process.stdout.write(new Uint8Array([0x75, 0x38, 0x0a]));
process.stdout.write('6869\n', 'hex');
const original = process.stdout.write;
const captured = [];
process.stdout.write = (chunk, ...rest) => {
  captured.push(String(chunk));
  return true;
};
console.log('captured line');
console.info('captured info');
process.stdout.write = original;
console.log('captured:', JSON.stringify(captured));
process.stderr.write('to stderr\n');
console.log(process.stdout.writable, process.stdout.writableEnded, process.stdout.destroyed, typeof process.stdout.end);
