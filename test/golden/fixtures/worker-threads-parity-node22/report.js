require('worker_threads').parentPort.postMessage(JSON.stringify({ preloaded: globalThis.preloaded ?? 0, other: !!globalThis.other }));
