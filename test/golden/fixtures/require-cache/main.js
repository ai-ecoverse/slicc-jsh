const a = require('./once.js');
const b = require('./once.js');
console.log(a.n, b.n, a === b, require.resolve('./once.js').endsWith('once.js'));
