// #93: events = Node 22's lib/events.js
const EventEmitter = require('events');
const { once, on, errorMonitor, captureRejectionSymbol, getEventListeners, setMaxListeners, getMaxListeners, listenerCount } = EventEmitter;
const log = (...a) => console.log(...a);
log('exports', Object.keys(EventEmitter).sort().join(','));
log('defaultMaxListeners', EventEmitter.defaultMaxListeners);
const e = new EventEmitter();
const order = [];
e.on('newListener', (n) => order.push('new:' + String(n)));
e.on('removeListener', (n) => order.push('rm:' + String(n)));
const f = () => order.push('f'); const g = () => order.push('g');
e.on('x', f); e.prependListener('x', g); e.once('x', () => order.push('once'));
e.emit('x'); e.emit('x');
e.off('x', f); e.removeAllListeners('x');
log('order', order.join(' '));
log('eventNames', e.eventNames().map(String).join(','), 'rawListeners', e.rawListeners('newListener').length);
// errorMonitor
const e2 = new EventEmitter();
e2.on(errorMonitor, (err) => log('monitor saw', err.message));
try { e2.emit('error', new Error('boom')); } catch (err) { log('emit error threw', err.message); }
try { new EventEmitter().emit('error', 'notanerror'); } catch (err) { log('non-error', err.code, err.message); }
try { new EventEmitter().emit('error'); } catch (err) { log('no arg', err.code, err.message); }
// max listeners warning text
process.on('warning', (w) => log('warning', w.name, w.message, w.count, w.type));
const e3 = new EventEmitter(); e3.setMaxListeners(2);
for (let i = 0; i < 3; i++) e3.on('ev', () => {});
log('getMaxListeners', e3.getMaxListeners(), getMaxListeners(e3), listenerCount(e3, 'ev'), e3.listenerCount('ev'));
setMaxListeners(5, e3); log('after setMaxListeners', e3.getMaxListeners());
log('getEventListeners', getEventListeners(e3, 'ev').length);
try { e3.setMaxListeners(-1); } catch (err) { log('neg max', err.code); }
try { e3.on('x', 'notfn'); } catch (err) { log('bad listener', err.code, err.message); }
// captureRejections
const e4 = new EventEmitter({ captureRejections: true });
e4.on('ev', async () => { throw new Error('rejected in listener'); });
e4.on('error', (err) => log('captured to error:', err.message));
e4.emit('ev');
const e5 = new EventEmitter({ captureRejections: true });
e5[captureRejectionSymbol] = (err, name) => log('symbol handler', name, err.message);
e5.on('ev2', async () => { throw new Error('r2'); });
e5.emit('ev2');
// once / on with AbortSignal
(async () => {
  const e6 = new EventEmitter();
  setTimeout(() => e6.emit('ready', 1, 2), 5);
  log('once ->', JSON.stringify(await once(e6, 'ready')));
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 5);
  try { await once(e6, 'never', { signal: ac.signal }); } catch (err) { log('once abort', err.name, err.code); }
  const e7 = new EventEmitter();
  setTimeout(() => { e7.emit('d', 'a'); e7.emit('d', 'b'); e7.emit('d', 'c'); }, 5);
  const got = [];
  const ac2 = new AbortController();
  try { for await (const [v] of on(e7, 'd', { signal: ac2.signal })) { got.push(v); if (got.length === 3) ac2.abort(); } } catch (err) { log('on abort', err.name, err.code); }
  log('on got', got.join(''));
  const e8 = new EventEmitter();
  setTimeout(() => e8.emit('error', new Error('once-err')), 5);
  try { await once(e8, 'x'); } catch (err) { log('once rejects on error', err.message); }
  const et = new EventTarget();
  setTimeout(() => et.dispatchEvent(new Event('ping')), 5);
  const [ev] = await once(et, 'ping'); log('once EventTarget', ev.type);
  log('Symbol.for nodejs.rejection', captureRejectionSymbol.toString());
})();
