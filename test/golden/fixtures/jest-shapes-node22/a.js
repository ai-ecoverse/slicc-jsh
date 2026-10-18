// A plain exports object in a cycle: reading a missing property warns.
exports.early = 1;
require('./b.js');
exports.late = 2;
