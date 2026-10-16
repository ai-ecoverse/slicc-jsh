process.stdout.write('a\n'); process.stdout.end('b\n', () => process.stderr.write('end cb\n'));
process.stdout.on('finish', () => process.stderr.write('finish\n'));
setTimeout(() => { try { process.stdout.write('after end\n'); } catch (e) { process.stderr.write('write after end threw ' + e.code + '\n'); } }, 10);
process.stdout.on('error', (e) => process.stderr.write('error event ' + e.code + '\n'));
