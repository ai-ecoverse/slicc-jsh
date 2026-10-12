const color = require('sliccy:color');
console.log('enabled', color.enabled);
console.log(JSON.stringify(color.red('red') + color.bold('bold') + color.dim('dim')));
console.log('keys', Object.keys(color).sort().join(','));
