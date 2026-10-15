const dc = require('diagnostics_channel');
const ch = dc.channel('my-ch');
console.log('hasSubscribers', ch.hasSubscribers, dc.hasSubscribers('my-ch'));
const fn = (m, n) => console.log('got', JSON.stringify(m), n);
dc.subscribe('my-ch', fn); console.log('hasSubscribers', ch.hasSubscribers);
ch.publish({ a: 1 }); dc.unsubscribe('my-ch', fn); ch.publish({ a: 2 }); console.log('after unsub', ch.hasSubscribers);
const tc = dc.tracingChannel('my-trace');
const ev = []; tc.subscribe({ start: (m) => ev.push('start'), end: () => ev.push('end'), asyncStart: () => ev.push('asyncStart'), asyncEnd: () => ev.push('asyncEnd'), error: (m) => ev.push('error:' + m.error.message) });
console.log('traceSync', tc.traceSync((x) => x * 2, { k: 1 }, null, 21), ev.join(','));
ev.length = 0; try { tc.traceSync(() => { throw new Error('bad'); }, {}); } catch (e) { console.log('traceSync threw', e.message, ev.join(',')); }
ev.length = 0; tc.tracePromise(async () => 5, {}).then((v) => console.log('tracePromise', v, ev.join(',')));
const sym = Symbol('s'); const c2 = dc.channel(sym); console.log('symbol channel', c2.name === sym);
dc.subscribe('console.log', (args) => { if (!globalThis.seen) { globalThis.seen = 1; process.stdout.write('console.log channel saw ' + JSON.stringify(args) + '\n'); } });
console.log('hello', 2);
dc.subscribe('boom-ch', () => { throw new Error('subscriber threw'); });
process.on('uncaughtException', (e) => console.log('uncaught', e.message));
dc.channel('boom-ch').publish({}); console.log('publish returned');
const sc = dc.channel('my-store'); console.log('bindStore', typeof sc.bindStore, typeof sc.runStores);
