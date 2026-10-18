import { parentPort, workerData } from 'node:worker_threads';
parentPort.postMessage({ esm: true, url: import.meta.url.endsWith('/w-esm.mjs'), workerData });
