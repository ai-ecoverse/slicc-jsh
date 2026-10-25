const vm = require('vm');
const s = "\tthrow new SyntaxError('v')";
vm.runInThisContext(s, { filename: 'a.vm' });
