const cli = require('sliccy:cli');
cli.die(new Error('from an Error'), { exitCode: 4, prefix: 'tool' });
