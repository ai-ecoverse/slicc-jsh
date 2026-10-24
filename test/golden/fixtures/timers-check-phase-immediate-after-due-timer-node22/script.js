const fs = require('fs');
const busy = () => { const start = Date.now(); while (Date.now() - start < 20) {} };
const busy2 = () => { const start = Date.now(); while (Date.now() - start < 2) {} };
const row = (label, start, count = 2) => new Promise((done) => {
  const out = [];
  out.push = (entry) => {
    Array.prototype.push.call(out, entry);
    if (out.length === count) setTimeout(() => { console.log(`${label} | ${out.join(', ')}`); done(); }, 0);
  };
  start(out);
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
  }), 3);
  await row('an immediate, then a setTimeout 10 that comes due, from an immediate', (out) => setImmediate(() => {
    setImmediate(() => out.push('immediate'));
    setTimeout(() => out.push('timeout 10'), 10);
    busy();
  }));
  await row('an immediate, then a setTimeout 10000 not yet due, from an immediate', (out) => setImmediate(() => {
    const later = setTimeout(() => out.push('timeout 10000'), 10000);
    setImmediate(() => { out.push('immediate'); clearTimeout(later); });
    busy();
  }), 1);
  await row("a readFile callback's setTimeout 0, then an immediate from its immediate", (out) => fs.readFile(__filename, () => {
    setTimeout(() => out.push('timeout 0'), 0);
    setImmediate(() => {
      out.push('immediate 1');
      setImmediate(() => out.push('immediate 2'));
      busy();
    });
  }), 3);
  await row("a timer's immediate, then its setTimeout 0", (out) => setTimeout(() => {
    setImmediate(() => out.push('immediate'));
    setTimeout(() => out.push('timeout 0'), 0);
    busy();
  }, 1));
  await new Promise((done) => {
    let n = 0;
    const iv = setInterval(() => { n++; busy2(); if (n > 300) { console.log('a busy interval from the main script | starved'); clearInterval(iv); done(); } }, 1);
    setImmediate(() => setImmediate(() => { console.log(`a busy interval from the main script | immediate ${n < 50 ? 'soon' : `late ${n}`}`); clearInterval(iv); done(); }));
  });
  await new Promise((done) => setImmediate(() => {
    let n = 0;
    const iv = setInterval(() => { n++; busy2(); if (n > 300) { console.log('a busy interval from an immediate | starved'); clearInterval(iv); done(); } }, 1);
    setImmediate(() => { console.log(`a busy interval from an immediate | immediate ${n < 50 ? 'soon' : `late ${n}`}`); clearInterval(iv); done(); });
  }));
  const ioAfter = (label, ioBusy) => new Promise((done) => {
    const out = [];
    const bound = setTimeout(() => { console.log(`${label} | stuck at ${out.join(' ')}`); done(out.join(' ')); }, 5000);
    const note = (entry) => {
      out.push(entry);
      if (out.length === 4) { clearTimeout(bound); done(out.join(' ')); }
    };
    setImmediate(() => {
      setTimeout(() => note('A'), 0);
      setImmediate(() => note('I'));
      fs.readFile(__filename, () => { setTimeout(() => note('T'), 0); const s = Date.now(); while (Date.now() - s < ioBusy) {} note('io'); });
      busy();
    });
  });
  console.log(`a readFile callback's setTimeout 0, the readFile started from an immediate | ${await ioAfter('a readFile callback', 5)}`);
  const orders = [];
  for (let i = 0; i < 20; i++) orders.push(await ioAfter(`iteration ${i}`, 1));
  console.log(`20 of them, with a 1 ms readFile callback | ${[...new Set(orders)].join('; ')}`);
  console.log('done');
})();
