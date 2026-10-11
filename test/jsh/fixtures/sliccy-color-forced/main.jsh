const color = require('sliccy:color');
console.log(String(color.enabled), JSON.stringify(color.green('ok')));
require('sliccy:cli').die('red prefix');
