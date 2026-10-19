// A long chain of promise jobs with nothing else pending: it runs to its end.
(async () => {
  let p = Promise.resolve(0);
  for (let i = 0; i < 2000; i++) p = p.then((n) => n + 1);
  const deep = async (n) => (n === 0 ? 'bottom' : await deep(n - 1));
  console.log('chain', await p, await deep(500), await Promise.all(Array.from({ length: 50 }, (_, i) => Promise.resolve(i).then((x) => x * 2))).then((a) => a.length));
})();
process.on('beforeExit', () => console.log('beforeExit'));
