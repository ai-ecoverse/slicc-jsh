// A .jsh file is the body of an async function (slicc v6's runUserCode).
undeclared = 'sloppy';
console.log('sloppy', globalThis.undeclared === 'sloppy');
const v = await Promise.resolve(42);
console.log('await', v);
console.log('module', typeof module, module.exports === exports, require.main === module);
console.log('filename', __filename.endsWith('/main.jsh'), __dirname === require('path').dirname(__filename));
console.log('argv', process.argv.length, process.argv[1] === __filename, JSON.stringify(process.argv.slice(2)));
console.log('fetch', typeof fetch);
console.log('version', typeof process.versions.jsh, /^\d+\.\d+\.\d+/.test(process.versions.jsh));
if (process.argv[2] === 'one') return;
console.log('not reached');
