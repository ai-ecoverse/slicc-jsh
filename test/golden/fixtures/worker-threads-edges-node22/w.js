require('worker_threads').parentPort.postMessage('w.js ran, its execArgv ' + JSON.stringify(process.execArgv));
