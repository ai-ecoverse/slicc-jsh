function inner() { throw new Error('boom'); }
try { inner(); } catch (e) { console.log('STACK<<' + e.stack + '>>'); }
const o = {}; Error.captureStackTrace(o); console.log('CST<<' + o.stack + '>>');
setTimeout(() => { throw new TypeError('uncaught one'); }, 5);
