const ah = require('async_hooks'); const events = require('events');
const P = (l, f) => { try { console.log(l, JSON.stringify(f())); } catch (e) { console.log(l, 'throws', e.code, String(e.message).split('\n')[0]); } };
P('keys', () => Object.keys(ah).sort());
P('AsyncResource', () => { const r = new ah.AsyncResource('X'); const id = r.asyncId(); let inside; r.runInAsyncScope(() => { inside = ah.executionAsyncId(); }); const b = ah.AsyncResource.bind(() => 7); return [typeof id, inside === id, b(), typeof r.triggerAsyncId()]; });
P('createHook', () => { const h = ah.createHook({ init() {} }); return [typeof h.enable, typeof h.disable, h.enable() === h]; });
P('AsyncLocalStorage', () => { const als = new ah.AsyncLocalStorage(); return als.run(5, () => als.getStore()); });
P('EventEmitterAsyncResource', () => { const e = new events.EventEmitterAsyncResource({ name: 'E' }); let got; e.on('x', (v) => (got = v)); e.emit('x', 3); return [got, typeof e.asyncId, typeof e.asyncResource]; });
P('spread events', () => Object.keys({ ...events }).length);
