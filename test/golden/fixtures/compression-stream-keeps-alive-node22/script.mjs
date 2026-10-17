// A pipe through the platform's CompressionStream / DecompressionStream keeps
// the program alive while the (de)compression runs off its thread, as Node
// counts that work as an active handle (#353: with nothing else pending the
// program ended as an unsettled top-level await; 8 MiB makes the work long
// enough on any machine). The class's shape is Node 22's.
import util from 'node:util';
import * as web from 'node:stream/web';
const big = new Uint8Array(8 * 1024 * 1024);
for (let i = 0; i < big.length; i++) big[i] = Math.imul(i, 2654435761) >>> 24;
const out = new ReadableStream({ start(c) { c.enqueue(big); c.close(); } })
  .pipeThrough(new CompressionStream('gzip'))
  .pipeThrough(new DecompressionStream('gzip'));
let n = 0;
let same = true;
for await (const ch of out) {
  for (let i = 0; i < ch.length; i++) if (ch[i] !== big[n + i]) same = false;
  n += ch.length;
}
console.log('gzip roundtrip', n, same);
const c = new CompressionStream('deflate-raw');
console.log(util.inspect(c, { depth: 0 }), Object.prototype.toString.call(c), c instanceof CompressionStream, web.DecompressionStream === DecompressionStream);
console.log(Object.getOwnPropertyNames(c).length, Object.getOwnPropertyNames(CompressionStream.prototype).sort().join(','), Object.getOwnPropertyDescriptor(globalThis, 'CompressionStream').enumerable);
