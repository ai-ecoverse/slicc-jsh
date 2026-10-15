const ph = require('perf_hooks');
console.log(Object.keys(ph).sort().join(','));
console.log(ph.performance === globalThis.performance, typeof ph.performance.now(), typeof ph.performance.timeOrigin, typeof ph.performance.eventLoopUtilization);
console.log(JSON.stringify(ph.constants));
ph.performance.mark('a'); for (let i = 0; i < 1e5; i++); ph.performance.mark('b');
const m = ph.performance.measure('a-b', 'a', 'b'); console.log(m.name, m.entryType, m.duration >= 0);
console.log(ph.performance.getEntriesByType('mark').map((e) => e.name).join(','));
const obs = new ph.PerformanceObserver((list, o) => { console.log('observed', list.getEntries().map((e) => e.name).join(',')); o.disconnect(); });
obs.observe({ entryTypes: ['mark'] }); ph.performance.mark('c');
const h = ph.createHistogram(); for (const v of [1, 2, 3, 100]) h.record(v);
console.log('hist', h.min, h.max, h.count, h.mean, h.percentile(50), h.percentile(100), h.exceeds);
try { h.record(0); } catch (e) { console.log('record 0', e.code); }
const hb = ph.createHistogram({ lowest: 1n, highest: 1000n }); hb.record(5n); console.log('bigint', hb.max, typeof hb.minBigInt);
try { ph.createHistogram({ lowest: 0 }); } catch (e) { console.log('lowest 0', e.code); }
const eld = ph.monitorEventLoopDelay({ resolution: 10 }); eld.enable();
setTimeout(() => { eld.disable(); console.log('eld', eld.count >= 0, typeof eld.mean, eld.min > 0 || eld.count === 0); }, 60);
const t = ph.performance.timerify(function sq(x) { return x * x; }); console.log('timerify', t(4), t.name);
const elu = ph.performance.eventLoopUtilization(); console.log('elu keys', Object.keys(elu).sort().join(','));
console.log('nodeTiming', typeof ph.performance.nodeTiming, ph.performance.toJSON && typeof ph.performance.toJSON());
