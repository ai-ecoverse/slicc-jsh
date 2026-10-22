const waitAsync = Atomics.waitAsync;
Atomics.waitAsync = function (...args) {
  const waited = waitAsync.apply(this, args);
  if (!waited.async) return waited;
  return { async: true, value: waited.value.then((result) => new Promise((resolve) => setTimeout(() => resolve(result), 5))) };
};
await import(new URL('./node-process-worker.js', import.meta.resolve('@ai-ecoverse/slicc-kernel/node')));
