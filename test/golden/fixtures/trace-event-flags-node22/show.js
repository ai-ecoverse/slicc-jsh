const traceEvents = require('trace_events');
console.log('execArgv', JSON.stringify(process.execArgv), 'categories', traceEvents.getEnabledCategories());
