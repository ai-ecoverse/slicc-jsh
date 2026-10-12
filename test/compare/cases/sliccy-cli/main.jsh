const cli = require('sliccy:cli');
console.log('keys', Object.keys(cli).sort().join(','));
cli.out('out string');
cli.out({ a: 1, b: [2] });
cli.warn('careful');
cli.warn('custom', { prefix: 'Note' });
try {
  cli.die('fatal problem', 3);
} catch (e) {
  console.log('die was catchable', e && e.name);
}
console.log('after die (must not print)');
