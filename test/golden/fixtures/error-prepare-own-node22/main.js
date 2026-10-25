const util = require('util');
const own = (s) => String(s).replaceAll(__dirname, 'DIR');
const frames = (stack) => own(stack).split('\n').filter((l) => !l.includes('node:')).join('\n');
const show = (label, fn) => {
  let value;
  try {
    value = fn();
  } catch (e) {
    value = `THROW ${e?.constructor?.name}: ${e?.message}`;
  }
  console.log(`${label}: ${typeof value === 'string' ? value : util.inspect(value)}`);
};
const site = (s) => `${own(s.getFileName())}:${s.getLineNumber()}:${s.getColumnNumber()} ${s.getFunctionName()} top=${s.isToplevel()}`;
const strange = (sites) => sites.filter((s) => {
  const f = String(s.getFileName() ?? '');
  return f !== __filename && !f.startsWith('node:') && f !== 'undefined';
}).length;

const d = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
show('descriptor', () => [typeof d.value, d.value?.name, d.writable, d.enumerable, d.configurable]);
show('proto is Function.prototype', () => Object.getPrototypeOf(Error) === Function.prototype);
show('keys', () => Object.keys(Error));
show('inspect', () => util.inspect(Error));

const callsites = require('callsites');
function where() {
  return callsites();
}
const cs = where();
show('callsites first', () => site(cs[0]));
show('callsites strange', () => strange(cs));

process.on('deprecation', (e) => {
  show('depd message', () => e.message);
  show('depd stack', () => frames(e.stack).split('\n').join(' | '));
});
const deprecate = require('depd')('my-mod');
function old() {
  deprecate('old() is gone');
}
function caller() {
  old();
}
function outer() {
  caller();
}
outer();

function formatted() {
  return new Error('f').stack;
}
let receiver;
let sites;
Error.prepareStackTrace = function fmt(e, s) {
  receiver = this;
  sites = s;
  return `${e.message}|${s.length > 0}`;
};
show('own formatter', () => formatted());
show('own formatter this', () => receiver === Error);
show('own formatter top', () => site(sites[0]));
show('own formatter strange', () => strange(sites));
show('own formatter proto methods', () => Object.getOwnPropertyNames(Object.getPrototypeOf(sites[0])).includes('getFileName'));
show('own formatter own props', () => Object.getOwnPropertyNames(sites[0]).length);
show('typeof set', () => typeof Error.prepareStackTrace);
Error.prepareStackTrace = (e, s) => s;
show('array result', () => Array.isArray(new Error('a').stack));
Error.prepareStackTrace = () => {
  throw new RangeError('from fmt');
};
show('throwing formatter', () => new Error('t').stack);
let depth = 0;
Error.prepareStackTrace = (e) => {
  if (depth++ > 0) return `inner ${e.message}`;
  const inner = new Error('in').stack;
  depth = 0;
  return `outer ${e.message} [${frames(inner).split('\n')[0]}]`;
};
show('nested', () => new Error('out').stack);
Error.prepareStackTrace = undefined;
show('undefined formatter', () => frames(new Error('u').stack));
Error.prepareStackTrace = 42;
show('non-function formatter', () => frames(new Error('n').stack));
Error.prepareStackTrace = d.value;
show('restored', () => frames(new Error('r').stack));

const p = Error.prepareStackTrace;
Error.prepareStackTrace = (_, s) => s;
const raw = new Error('raw').stack;
Error.prepareStackTrace = p;
show('save and restore', () => [Error.prepareStackTrace === p, p.name, Array.isArray(raw)]);

RangeError.prepareStackTrace = () => 'range';
show('subclass formatter', () => [frames(new RangeError('x').stack), frames(new Error('y').stack)]);
show('subclass own', () => Object.keys(RangeError));
delete RangeError.prepareStackTrace;

show('delete', () => delete Error.prepareStackTrace);
show('typeof after delete', () => typeof Error.prepareStackTrace);
show('in after delete', () => 'prepareStackTrace' in Error);
show('proto after delete', () => Object.getPrototypeOf(Error) === Function.prototype);
show('stack after delete', () => frames(new Error('d').stack));
show('TypeError after delete', () => {
  try {
    null.x;
  } catch (e) {
    return frames(e.stack);
  }
});
show('inspect after delete', () => util.inspect(Error));
Error.prepareStackTrace = function again(e) {
  return `again ${e.message}`;
};
show('set after delete', () => new Error('s').stack);
show('keys after set', () => Object.keys(Error));
show('inspect after set', () => util.inspect(Error));
show('descriptor after set', () => {
  const x = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  return [x.value.name, x.writable, x.enumerable, x.configurable, 'get' in x];
});
delete Error.prepareStackTrace;

class Sub extends Error {}
Object.freeze(Sub);
const made = Object.freeze(Object.create(Error));
show('sloppy frozen subclass', () => {
  Sub.prepareStackTrace = () => 'sub';
  return Object.hasOwn(Sub, 'prepareStackTrace');
});
show('strict frozen subclass', () => {
  'use strict';
  Sub.prepareStackTrace = () => 'sub';
  return Object.hasOwn(Sub, 'prepareStackTrace');
});
show('strict frozen object from Error', () => {
  'use strict';
  made.prepareStackTrace = () => 'made';
  return Object.hasOwn(made, 'prepareStackTrace');
});
Error.prepareStackTrace = d.value;
show('strict frozen subclass with Error own', () => {
  'use strict';
  Sub.prepareStackTrace = () => 'sub';
  return Object.hasOwn(Sub, 'prepareStackTrace');
});
show('final', () => frames(new Error('end').stack));
