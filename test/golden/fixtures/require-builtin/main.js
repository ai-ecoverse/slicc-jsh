const path = require('path');
const buf = require('buffer');
console.log(path.join('a', 'b'), typeof buf.Buffer.from, require.resolve('path'));
