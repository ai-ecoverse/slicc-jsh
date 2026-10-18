const domain = require('domain');
console.log('process.domain before', process.domain);
let stage = 0;
const d = domain.create();
d.on('error', (e) => {
  console.log('domain error', e.message, e.domainThrown, typeof e.domain);
  stage++;
});
d.run(() => {
  console.log('active', process.domain === d, domain.active === d);
  setImmediate(() => {
    setTimeout(() => {
      throw new Error('in timer');
    }, 5);
    throw new Error('in immediate');
  });
  process.nextTick(() => {
    throw new Error('in tick');
  });
});
const d2 = domain.create();
d2.on('error', (e) => {
  console.log('d2', e.message);
  stage++;
});
const ee = new (require('events'))();
d2.add(ee);
ee.emit('error', new Error('emitter'));
const cb = d2.bind((x) => {
  throw new Error('bound ' + x);
});
const icb = d2.intercept((v) => {
  console.log('intercepted value', v);
  stage++;
});
const plan = {
  4: () => cb(1),
  5: () => icb(new Error('intercepted err')),
  6: () => icb(null, 42),
  7: () => {
    console.log('after, domain', process.domain === undefined ? 'undef' : process.domain);
    clearInterval(seq);
  },
};
let ran = -1;
const seq = setInterval(() => {
  if (stage === ran || !plan[stage]) return;
  ran = stage;
  plan[stage]();
}, 1);
