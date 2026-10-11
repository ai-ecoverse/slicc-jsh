exports.name = 'lib.js';
exports.file = __filename;
exports.mainIsEntry = require.main === module ? 'lib is main' : (require.main ? require.main.filename : 'no main');
