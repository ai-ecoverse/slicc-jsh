const domain = require('domain');
console.log('process.domain before', process.domain);
const d = domain.create();
d.on('error', (e) => console.log('domain error', e.message, e.domainThrown, typeof e.domain));
d.run(() => {
  console.log('active', process.domain === d, domain.active === d);
  setTimeout(() => { throw new Error('in timer'); }, 5);
  setImmediate(() => { throw new Error('in immediate'); });
  process.nextTick(() => { throw new Error('in tick'); });
});
const d2 = domain.create(); d2.on('error', (e) => console.log('d2', e.message));
const ee = new (require('events'))(); d2.add(ee); ee.emit('error', new Error('emitter'));
const cb = d2.bind((x) => { throw new Error('bound ' + x); }); setTimeout(() => cb(1), 10);
const icb = d2.intercept((v) => console.log('intercepted value', v)); setTimeout(() => icb(new Error('intercepted err')), 15); setTimeout(() => icb(null, 42), 16);
setTimeout(() => console.log('after, domain', process.domain === undefined ? 'undef' : process.domain), 40);
