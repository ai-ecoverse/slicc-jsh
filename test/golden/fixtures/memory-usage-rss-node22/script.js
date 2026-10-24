const { Worker } = require('node:worker_threads');
const MiB = 1024 * 1024;
const facts = (m, rss) => ({
  rss: typeof m.rss === 'number' && Number.isInteger(m.rss) && m.rss > MiB,
  aboveHeap: m.rss > m.heapUsed,
  rssFn: typeof rss === 'number' && Number.isInteger(rss) && rss > MiB,
});
console.log('main', facts(process.memoryUsage(), process.memoryUsage.rss()));
const w = new Worker(
  `const { parentPort } = require('node:worker_threads');
  parentPort.postMessage({ m: process.memoryUsage(), rss: process.memoryUsage.rss() });`,
  { eval: true }
);
w.on('message', ({ m, rss }) => console.log('worker', facts(m, rss)));
