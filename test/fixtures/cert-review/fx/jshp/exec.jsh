const exec = require('sliccy:exec');
const a = await exec('echo hi && echo err 1>&2; exit 3'); console.log('shell', JSON.stringify(a));
const b = await exec.spawn(['echo', 'a b', '$HOME']); console.log('spawn', JSON.stringify(b));
const c = await exec('definitely-not-a-command-xyz'); console.log('missing', c.exitCode, JSON.stringify(c.stderr.trim()));
const d = await exec.spawn(['definitely-not-a-command-xyz']); console.log('missing spawn', d.exitCode, JSON.stringify(d.stderr.trim()));
