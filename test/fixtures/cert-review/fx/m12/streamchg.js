const Stream = require('stream'); const { StringDecoder } = require('string_decoder'); const assert = require('assert'); const util = require('util');
console.log('stream identity', Stream === Stream.Stream, Stream === Stream.Readable, typeof Stream.Readable, typeof Stream.pipeline, typeof Stream.promises, Object.getPrototypeOf(Stream.Readable.prototype) === Stream.prototype);
const s = new Stream(); console.log('new Stream', typeof s.pipe, s instanceof require('events'));
console.log('Readable instanceof Stream', new Stream.Readable({ read() {} }) instanceof Stream);
console.log('base64url decoder', new StringDecoder('base64url').write(Buffer.from([0xfb, 0xff, 0xbf])) + '|' + new StringDecoder('base64url').end(Buffer.from([0xfb, 0xff])));
console.log('assert.throws regexp', String(assert.throws(() => { throw new Error('boom 42'); }, /boom \d+/)));
console.log('assert.throws object regexp prop', String(assert.throws(() => { throw new TypeError('bad thing'); }, { name: 'TypeError', message: /bad/ })));
try { assert.throws(() => { throw new Error('x'); }, { message: /y/ }); console.log('no throw?'); } catch (e) { console.log('assert.throws mismatch', e.code, e.name); }
console.log('assert.throws fn', String(assert.throws(() => { throw new Error('v'); }, (e) => e.message === 'v')));
try { assert.throws(() => {}); } catch (e) { console.log('assert.throws none', e.code, e.message); }
console.log('getCallSites', typeof util.getCallSites, util.getCallSites ? JSON.stringify(Object.keys(util.getCallSites()[0] || {}).sort()) : '');
const orig = Error.prepareStackTrace; Error.prepareStackTrace = (e, cs) => 'custom:' + cs.length; const st = new Error('x').stack; Error.prepareStackTrace = orig; console.log('prepareStackTrace', String(st).startsWith('custom:'), String(new Error('y').stack).split('\n')[0]);
for (let i = 0; i < 3; i++) { const o = Error.prepareStackTrace; Error.prepareStackTrace = undefined; new Error('z').stack; Error.prepareStackTrace = o; } console.log('restore x3 ok', String(new Error('w').stack).split('\n')[0]);
