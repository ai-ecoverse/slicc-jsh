const assert = require('assert');
const Stream = require('stream');
const util = require('util');
const { StringDecoder } = require('string_decoder');
const show = (label, f) => {
  let v;
  try {
    v = JSON.stringify(f());
  } catch (e) {
    v = `THROW ${e.name} ${e.code} ${JSON.stringify(e.message.split('\n')[0])}`;
  }
  console.log(`${label}: ${v}`);
};

show('stream is Stream', () => [typeof Stream, Stream.name, Stream === Stream.Stream, new Stream() instanceof Stream.Readable,
  ['Readable', 'Writable', 'Duplex', 'Transform', 'PassThrough', 'pipeline', 'finished', 'promises', 'compose'].map((k) => typeof Stream[k])]);
show('legacy pipe', () => {
  class Old extends Stream {
    constructor() {
      super();
      this.readable = true;
    }
  }
  const got = [];
  const old = new Old();
  const w = new Stream.Writable({ write(c, e, cb) { got.push(c.toString()); cb(); } });
  old.pipe(w);
  old.emit('data', Buffer.from('a'));
  old.emit('data', Buffer.from('b'));
  return got;
});

const boom = () => {
  const e = new TypeError('bad thing happened');
  e.code = 'ERR_X';
  throw e;
};
show('throws regexp property', () => assert.throws(boom, { message: /bad thing/, code: 'ERR_X', name: 'TypeError' }));
show('throws regexp property mismatch', () => assert.throws(boom, { message: /nope/ }));
show('throws validation function', () => assert.throws(boom, (err) => err.code === 'ERR_X'));
show('throws validation function false', () => assert.throws(boom, function check() { return false; }));
show('throws arrow + class', () => assert.throws(boom, TypeError));
show('throws wrong class', () => assert.throws(boom, RangeError));
show('throws Error object', () => assert.throws(boom, new TypeError('bad thing happened')));
show('throws missing key', () => assert.throws(boom, { errno: 1 }));

function where() {
  return util.getCallSites(2).map((c) => [c.functionName, c.scriptName.split('/').pop(), c.lineNumber, c.columnNumber === c.column]);
}
show('getCallSites', () => where());
show('getCallSites default 10', () => {
  const deep = (n) => (n ? deep(n - 1) : util.getCallSites().length);
  return deep(20);
});
show('getCallSites options only', () => util.getCallSites({ sourceMap: false }).length > 0);
show('getCallSites keeps a custom prepareStackTrace', () => {
  Error.prepareStackTrace = (err, sites) => `custom ${sites.length > 0}`;
  util.getCallSites();
  const s = new Error('x').stack;
  Error.prepareStackTrace = undefined;
  return [s, new Error('y').stack.split('\n')[0]];
});
show('save/restore a custom prepareStackTrace', () => {
  Error.prepareStackTrace = () => 'mine';
  const saved = Error.prepareStackTrace;
  Error.prepareStackTrace = (_, sites) => sites;
  const sites = new Error().stack;
  Error.prepareStackTrace = saved;
  const s = new Error().stack;
  Error.prepareStackTrace = undefined;
  return [Array.isArray(sites), s];
});
show('getCallSites bad', () => util.getCallSites('x'));
show('getCallSites 0', () => util.getCallSites(0));

show('prepareStackTrace save/restore', () => {
  const orig = Error.prepareStackTrace;
  Error.prepareStackTrace = (_, sites) => sites;
  const sites = new Error().stack;
  Error.prepareStackTrace = orig;
  let after;
  try {
    null.x;
  } catch (e) {
    after = e.stack.split('\n')[0];
  }
  return [Array.isArray(sites), typeof sites[0].getFileName, after];
});

show('base64url decoder', () => {
  const d = new StringDecoder('base64url');
  return [d.encoding, d.write(Buffer.from([251])), d.write(Buffer.from([255, 191, 1, 2])), d.end(Buffer.from([3]))];
});
show('unknown encoding', () => new StringDecoder('nope'));
