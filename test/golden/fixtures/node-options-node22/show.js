console.log('execArgv', JSON.stringify(process.execArgv), 'noDeprecation', process.noDeprecation, 'title', process.title, 'stackTraceLimit', Error.stackTraceLimit);
process.emitWarning('a warning');
