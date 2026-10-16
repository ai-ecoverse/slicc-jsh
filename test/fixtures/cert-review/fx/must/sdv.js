const { StringDecoder } = require('string_decoder');
const b = Buffer.from('héllo wörld!!!!!', 'utf8'); // 18 bytes
const views = [new Uint8Array(b.buffer, b.byteOffset, b.length), new Int8Array(b.buffer, b.byteOffset, b.length), new Uint8ClampedArray(b.buffer, b.byteOffset, b.length), new Uint16Array(b.buffer.slice(b.byteOffset, b.byteOffset + 18)), new Float64Array(new Uint8Array([...b, 0, 0, 0, 0, 0, 0]).buffer), new DataView(b.buffer, b.byteOffset, b.length)];
for (const v of views) { const d = new StringDecoder('utf8'); try { console.log(v.constructor.name, JSON.stringify(d.write(v) + d.end()).slice(0, 60)); } catch (e) { console.log(v.constructor.name, e.name, e.code, e.message.slice(0, 80)); } }
for (const v of views.slice(1, 2)) { try { console.log('Buffer.from(Int8Array).toString', JSON.stringify(Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString())); } catch (e) { console.log(e.message); } }
try { console.log('d.write(123)', new StringDecoder().write(123)); } catch (e) { console.log('d.write(123)', e.name, e.code, e.message.slice(0, 120)); }
