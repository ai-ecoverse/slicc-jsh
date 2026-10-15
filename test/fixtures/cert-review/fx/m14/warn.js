const util = require('util');
process.emitWarning('plain warning');
process.emitWarning('typed', 'CustomWarning', 'C001');
process.emitWarning('with detail', { type: 'XWarning', code: 'X1', detail: 'some detail' });
const dep = util.deprecate(() => 'r', 'old() is deprecated', 'DEP_X1'); dep(); dep();
process.emitWarning(new Error('from error object'));
process.on('warning', (w) => console.log('listener', w.name, w.message, w.code ?? ''));
console.log('sync end');
