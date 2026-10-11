const exec = require('sliccy:exec');
console.log(JSON.stringify(await exec.spawn(['node', '-e', "console.log('child'); console.error('warn'); process.exit(3)"])));
console.log(JSON.stringify(await exec.spawn(['no-such-command-here', 'x'])));
const h = exec.start(['node', '-e', 'process.exit(0)']);
console.log(JSON.stringify(await h.kill()), JSON.stringify(await h.done));
console.log(exec.exec === exec);
