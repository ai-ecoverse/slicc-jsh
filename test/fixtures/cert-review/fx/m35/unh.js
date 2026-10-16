const mode = process.argv[2];
process.on('exit', (c) => console.log('exit', c, process.exitCode));
if (mode === 'listener') { process.on('uncaughtException', (e, origin) => console.log('uncaught', e && e.message, origin)); Promise.reject(new Error('r1')); setTimeout(() => console.log('timer runs'), 10); }
if (mode === 'both') { process.on('unhandledRejection', (r) => console.log('unhandledRejection', r.message)); process.on('uncaughtException', (e, o) => console.log('uncaught', e.message, o)); Promise.reject(new Error('r2')); }
if (mode === 'monitor') { process.on('uncaughtExceptionMonitor', (e, o) => console.log('monitor', e.message, o)); Promise.reject(new Error('r3')); }
if (mode === 'nonerror') { process.on('uncaughtException', (e, o) => console.log('uncaught', typeof e, String(e), o)); Promise.reject(42); }
if (mode === 'capture') { process.setUncaughtExceptionCaptureCallback((e) => console.log('capture', e.message)); Promise.reject(new Error('r4')); setTimeout(() => console.log('after capture'), 10); }
if (mode === 'none') { Promise.reject(new Error('r5')); setTimeout(() => console.log('never'), 10); }
if (mode === 'late') { const p = Promise.reject(new Error('r6')); process.on('rejectionHandled', () => console.log('rejectionHandled')); process.on('uncaughtException', (e, o) => console.log('uncaught', e.message, o)); setTimeout(() => p.catch(() => console.log('caught late')), 20); }
if (mode === 'throwing-listener') { process.on('uncaughtException', (e) => { console.log('first', e.message); throw new Error('from listener'); }); Promise.reject(new Error('r7')); }
if (mode === 'async-fn') { process.on('uncaughtException', (e, o) => console.log('uncaught', e.message, o)); (async () => { await null; throw new Error('r8'); })(); }
