const { Readable, PassThrough } = require('stream');
const r = new Readable({ read() {} }); r.setEncoding('utf8'); let s = ''; r.on('data', (c) => (s += c)); r.on('end', () => console.log('setEncoding + Uint8Array push:', JSON.stringify(s)));
r.push(new Uint8Array([0x68, 0xc3, 0xa9])); r.push(null);
const p = new PassThrough(); p.setEncoding('utf8'); let t = ''; p.on('data', (c) => (t += c)); p.on('end', () => console.log('PassThrough setEncoding + Uint8Array write:', JSON.stringify(t)));
p.end(new Uint8Array([0x77, 0xc3, 0xb6]));
