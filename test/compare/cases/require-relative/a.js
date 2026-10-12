exports.a = 'a';
const b = require('./b.js');
module.exports = { a: 'a', b: b.b, bSawA: b.sawA };
