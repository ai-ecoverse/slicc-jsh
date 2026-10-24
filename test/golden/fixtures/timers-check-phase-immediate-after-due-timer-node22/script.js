const fs = require('fs');
const busy = () => { const start = Date.now(); while (Date.now() - start < 20) {} };
const row = (label, start) => new Promise((done) => {
  const out = [];
  start(out);
  setTimeout(() => { console.log(`${label} | ${out.join(', ')}`); done(); }, 150);
});
(async () => {
  await row('an immediate, then a setTimeout 0, from an immediate', (out) => setImmediate(() => {
    setImmediate(() => out.push('immediate'));
    setTimeout(() => out.push('timeout 0'), 0);
    busy();
  }));
  await row("an immediate, then a setTimeout 0, from an immediate's promise continuation", (out) => setImmediate(() => Promise.resolve().then(() => {
    setImmediate(() => out.push('immediate'));
    setTimeout(() => out.push('timeout 0'), 0);
    busy();
  })));
  await row('an immediate, a setTimeout 0 and an immediate, from an immediate', (out) => setImmediate(() => {
    setImmediate(() => out.push('immediate 1'));
    setTimeout(() => out.push('timeout 0'), 0);
    setImmediate(() => out.push('immediate 2'));
    busy();
  }));
  await row('an immediate, then a setTimeout 10 that comes due, from an immediate', (out) => setImmediate(() => {
    setImmediate(() => out.push('immediate'));
    setTimeout(() => out.push('timeout 10'), 10);
    busy();
  }));
  await row('an immediate, then a setTimeout 100 not yet due, from an immediate', (out) => setImmediate(() => {
    setImmediate(() => out.push('immediate'));
    setTimeout(() => out.push('timeout 100'), 100);
    busy();
  }));
  await row("a readFile callback's setTimeout 0, then an immediate from its immediate", (out) => fs.readFile(__filename, () => {
    setTimeout(() => out.push('timeout 0'), 0);
    setImmediate(() => {
      out.push('immediate 1');
      setImmediate(() => out.push('immediate 2'));
      busy();
    });
  }));
  await row("a timer's immediate, then its setTimeout 0", (out) => setTimeout(() => {
    setImmediate(() => out.push('immediate'));
    setTimeout(() => out.push('timeout 0'), 0);
    busy();
  }, 1));
  console.log('done');
})();
