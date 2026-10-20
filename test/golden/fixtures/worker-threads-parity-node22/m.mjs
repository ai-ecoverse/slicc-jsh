import { parentPort } from 'node:worker_threads'; parentPort.postMessage(new URL(import.meta.url).search + new URL(import.meta.url).hash + '|' + import.meta.url.endsWith('m.mjs'));
