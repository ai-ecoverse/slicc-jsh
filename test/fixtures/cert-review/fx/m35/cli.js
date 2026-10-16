const Module = require('module');
console.log('execArgv', JSON.stringify(process.execArgv), 'argv', JSON.stringify(process.argv.slice(2)));
const lp = Module._resolveLookupPaths('x', { paths: ['/a/node_modules'], filename: '/a/b.js', id: '/a/b.js' });
const nz = (a) => a && a.map((p) => p.replace(process.env.HOME || '~', '~').replace(/.*\/lib\/node$/, '<prefix>/lib/node'));
console.log('lookup bare', JSON.stringify(nz(lp)));
console.log('lookup rel', JSON.stringify(Module._resolveLookupPaths('./x', { paths: [], filename: '/a/b.js', id: '/a/b.js' })));
console.log('lookup builtin', JSON.stringify(Module._resolveLookupPaths('fs', null)));
console.log('globalPaths', Array.isArray(Module.globalPaths), Module.globalPaths.map((p) => p.replace(process.env.HOME || '~', '~').replace(/.*\/lib\/node$/, '<prefix>/lib/node')).join(','));
