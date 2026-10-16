const mode = process.argv[2];
process.on('exit', (c) => process.stderr.write(`exit listener ${c}\n`));
if (mode === 'write') { const w = () => process.stdout.write('x'.repeat(1000) + '\n', (e) => { if (!e) setImmediate(w); }); w(); }
if (mode === 'console') { let i = 0; const w = () => { console.log('y'.repeat(1000)); if (++i < 3000) setImmediate(w); else process.stderr.write('console survived\n'); }; w(); }
if (mode === 'listener') { const h = () => {}; process.on('SIGPIPE', h); process.off('SIGPIPE', h); const w = () => process.stdout.write('z'.repeat(1000) + '\n', (e) => { if (!e) setImmediate(w); }); w(); }
if (mode === 'handled') { process.stdout.on('error', (e) => { process.stderr.write(`error ${e.code} ${e.errno} ${e.syscall}\n`); process.exit(4); }); const w = () => process.stdout.write('w'.repeat(1000) + '\n', (e) => { if (!e) setImmediate(w); }); w(); }
