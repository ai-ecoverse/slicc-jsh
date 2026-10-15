import { text, json, buffer, arrayBuffer, blob } from 'node:stream/consumers';
import { Readable } from 'node:stream';
const mk = (...c) => Readable.from(c);
console.log(await text(mk('a', 'b', 'ü')));
console.log(await json(mk('{"x":', '[1,2]}')));
console.log((await buffer(mk(Buffer.from([1, 2]), Buffer.from([3])))).toString('hex'));
console.log((await arrayBuffer(mk('abc'))).byteLength);
const b = await blob(mk('blobby')); console.log(b.size, await b.text());
const ws = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('web')); c.close(); } });
console.log(await text(ws));
try { await json(mk('{bad')); } catch (e) { console.log('json error', e.name); }
