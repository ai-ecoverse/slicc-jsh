const exec = require('sliccy:exec');
console.log(JSON.stringify(await exec('echo "$((6 * 7))"; echo oops >&2; exit 2')));
const h = exec.start('cat');
h.stdin.write('piped ');
h.stdin.write('input');
h.stdin.end();
console.log(JSON.stringify(await h.done));
