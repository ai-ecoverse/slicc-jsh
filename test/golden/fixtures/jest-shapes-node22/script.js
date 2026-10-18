// The runtime shapes jest 29 and source-map-support depend on, against host Node 22.
const Module = require('module');

// jest-util createProcessObject: every constructor up process's chain, called
// on a copy of process, without new.
const copy = Object.create(Object.getPrototypeOf(process));
const names = [];
for (let proto = process; (proto = Object.getPrototypeOf(proto)); ) {
  if (typeof proto.constructor === 'function') {
    proto.constructor.call(copy);
    names.push(proto.constructor.name);
  }
}
console.log('constructors', names.join(' < '), typeof copy.on);

// source-map-support cloneCallSite: the methods are on the call site's prototype.
const saved = Error.prepareStackTrace;
Error.prepareStackTrace = (err, sites) => sites;
const sites = new Error('x').stack;
Error.prepareStackTrace = saved;
const site = sites[0];
const proto = Object.getPrototypeOf(site);
console.log(
  'call site',
  Object.getOwnPropertyNames(site).length,
  proto.constructor.name,
  ['getFileName', 'getLineNumber', 'getColumnNumber', 'getFunctionName', 'isNative', 'isEval', 'isConstructor', 'isToplevel', 'getTypeName', 'getMethodName', 'getEvalOrigin', 'getScriptNameOrSourceURL', 'toString'].every(
    (name) => typeof proto[name] === 'function'
  )
);
const clone = {};
for (const name of Object.getOwnPropertyNames(proto)) {
  clone[name] = /^(?:is|get)/.test(name) ? () => site[name]() : site[name];
}
console.log('clone', clone.isNative(), clone.getLineNumber(), typeof clone.getFileName(), clone.getFileName() === site.getFileName());
try {
  proto.getLineNumber.call({});
} catch (e) {
  console.log('detached method', e.constructor.name);
}

// jest-runtime: Module's enumerable keys copied onto a subclass.
class Sub extends Module.Module {}
let failed = [];
for (const [key, value] of Object.entries(Module.Module)) {
  try {
    Sub[key] = value;
  } catch (e) {
    failed.push(key);
  }
}
console.log('copied onto a subclass', failed.length === 0 ? 'all' : failed.join(), Sub.SourceMap === Module.SourceMap, Object.getOwnPropertyDescriptor(Sub, 'SourceMap') !== undefined);

// The circular require warning, as a 'warning' event (the default listener,
// which prints it with the pid, taken off).
process.removeAllListeners('warning');
process.on('warning', (w) => console.log('warning event:', w.name, w.message));
require('./a.js');
require('./c.js');
setImmediate(() => console.log('done'));
