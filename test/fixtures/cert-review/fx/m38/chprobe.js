const vm = require('vm');
const caps = ['Worker', 'SharedWorker', 'BroadcastChannel', 'importScripts', 'postMessage', 'indexedDB', 'caches', 'XMLHttpRequest', 'EventSource', 'WebSocket', 'fetch', 'navigator', 'self', 'close', 'onmessage', 'FileSystemDirectoryHandle', 'FileSystemSyncAccessHandle', 'WorkerGlobalScope', 'DedicatedWorkerGlobalScope', 'WorkerNavigator', 'StorageManager', 'MessagePort', 'MessageChannel', 'Atomics', 'SharedArrayBuffer'];
const look = (g, label) => {
  const have = caps.filter((n) => { try { return g[n] !== undefined && g[n] !== null; } catch { return false; } });
  console.log(label, 'has', have.join(',') || '(none)');
};
look(globalThis, 'program');
const chain = []; let p = Object.getPrototypeOf(globalThis); while (p) { chain.push((p.constructor && p.constructor.name) || '?'); p = Object.getPrototypeOf(p); }
console.log('global proto chain', chain.join(' > '));
const protoOwn = []; p = Object.getPrototypeOf(globalThis); while (p && p !== Object.prototype) { for (const n of Object.getOwnPropertyNames(p)) if (caps.includes(n)) protoOwn.push(n); p = Object.getPrototypeOf(p); }
console.log('capabilities on the proto chain', protoOwn.join(',') || '(none)');
try { console.log('navigator.storage', typeof navigator?.storage, typeof navigator?.storage?.getDirectory); } catch (e) { console.log('navigator.storage throws', e.name); }
const ctx = vm.createContext({});
const viaFn = vm.runInContext('this.constructor.constructor("return globalThis")()', ctx);
console.log('ctx escape == program global', viaFn === globalThis);
look(vm.runInContext('this', ctx), 'ctx this');
console.log('ctx names', vm.runInContext(`${JSON.stringify(caps)}.filter((n) => { try { return eval(n) !== undefined } catch { return false } }).join(',') || '(none)'`, ctx));
const r = (() => { try { return vm.runInContext('(function(){ return this })()', ctx) === globalThis; } catch (e) { return e.name; } })();
console.log('sloppy this in ctx is program global', r);
try { console.log('Function("return this")() is program global', Function('return this')() === globalThis); } catch (e) { console.log('Function ctor', e.name); }
try { const w = new (Function('return this')().Worker || class { constructor() { throw new Error('no Worker'); } })('data:,'); console.log('Worker CREATED', typeof w); } catch (e) { console.log('Worker', e.message); }
try { const b = new BroadcastChannel('x'); console.log('BroadcastChannel CREATED', typeof b.postMessage); b.close(); } catch (e) { console.log('BroadcastChannel', e.name, e.message.slice(0, 60)); }
const repl = require('repl'); const { PassThrough } = require('stream');
const rs = repl.start({ input: new PassThrough(), output: new PassThrough(), terminal: false }); look(rs.context, 'repl context'); rs.close();
const ph = require('perf_hooks');
const res = (now) => { let m = Infinity, last = now(); for (let i = 0; i < 200000 && m > 0.0005; i++) { const t = now(); if (t > last) m = Math.min(m, t - last); last = t; } return m.toFixed(4) + 'ms'; };
console.log('perf_hooks min step', res(() => ph.performance.now()), 'global performance', res(() => performance.now()), 'Date', res(() => Date.now()));
console.log('perf timeOrigin type', typeof ph.performance.timeOrigin, 'same performance object', ph.performance === globalThis.performance);
const h = ph.createHistogram(); h.record(1); console.log('histogram ok', h.count);
const dc = require('diagnostics_channel'); console.log('dc', typeof dc.channel('x').publish);
console.log('domain', typeof require('domain').create, 'sys', typeof require('sys').inspect, 'stream/web', typeof require('stream/web').ReadableStream, 'consumers', typeof require('stream/consumers').text);
