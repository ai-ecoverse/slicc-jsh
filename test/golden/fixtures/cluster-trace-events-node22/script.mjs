// require('cluster') and require('trace_events') load with Node 22.22.0's
// exports: cluster as the primary (no workers forked here), trace_events'
// Tracing objects and the agent's enabled set.
import clusterDefault, { isPrimary } from 'node:cluster';
import traceDefault, { createTracing } from 'node:trace_events';
import * as cns from 'cluster';
import * as tns from 'trace_events';
import { createRequire, isBuiltin, builtinModules } from 'node:module';
import { EventEmitter } from 'node:events';
import { inspect } from 'node:util';

const require = createRequire(import.meta.url);
const cluster = require('cluster');
const te = require('trace_events');
const show = (label, f) => {
  try {
    const v = f();
    console.log(label, v === undefined ? 'undefined' : JSON.stringify(v));
  } catch (e) {
    console.log(label, 'throws', e.name, e.code, e.message);
  }
};
process.on('warning', (w) => console.log('warning', w.message));

show('cluster keys', () => Object.keys(cluster));
show('cluster same', () => [require('node:cluster') === cluster, clusterDefault === cluster, cns.default === cluster, isPrimary, cluster instanceof EventEmitter]);
show('cluster esm keys', () => Object.keys(cns).sort());
show('builtin', () => ['cluster', 'trace_events'].map((m) => [isBuiltin(m), builtinModules.includes(m)]));
show('cluster values', () => [cluster.isPrimary, cluster.isMaster, cluster.isWorker, cluster.schedulingPolicy, cluster.SCHED_NONE, cluster.SCHED_RR, cluster.settings, cluster.workers, cluster.setupMaster === cluster.setupPrimary]);
show('cluster functions', () => ['setupPrimary', 'fork', 'disconnect', 'Worker'].map((k) => `${k}:${cluster[k].name}/${cluster[k].length}`));
show('Worker', () => {
  const w = new cluster.Worker({ id: '3', state: 'online' });
  const w2 = cluster.Worker();
  const w3 = new cluster.Worker(null);
  return [w instanceof EventEmitter, w.id, w.state, w.exitedAfterDisconnect, Object.keys(w), w2 instanceof cluster.Worker, w2.id, w2.state, w3.state, Object.getOwnPropertyNames(cluster.Worker.prototype), Object.getPrototypeOf(cluster.Worker) === EventEmitter];
});
const setup = new Promise((resolve) => cluster.once('setup', (s) => {
  console.log('setup event', Object.keys(s), s.silent, s.foo, s.args, s.execArgv, s.exec === process.argv[1]);
  resolve();
}));
cluster.setupPrimary({ foo: 1, execArgv: ['--prof'] });
show('settings sync', () => [Object.keys(cluster.settings), cluster.settings.execArgv]);
await setup;
cluster.setupPrimary({ silent: true });
await new Promise((resolve) => cluster.once('setup', (s) => {
  console.log('setup again', s.silent, s.foo);
  resolve();
}));
await new Promise((resolve) => cluster.disconnect(() => {
  console.log('disconnected');
  resolve();
}));

show('trace keys', () => Object.keys(te));
show('trace same', () => [require('node:trace_events') === te, traceDefault === te, tns.default === te, createTracing === te.createTracing, Object.keys(tns).sort()]);
show('trace functions', () => Object.entries(te).map(([k, v]) => `${k}:${v.name}/${v.length}`));
show('none enabled', () => te.getEnabledCategories());
const a = te.createTracing({ categories: ['node.perf', 'v8'] });
const b = te.createTracing({ categories: ['node', 'v8', 'a'] });
show('tracing', () => [inspect(a), inspect({ t: a }), inspect(a, { depth: -1 }), a.enabled, a.categories, a.constructor.name, Object.getOwnPropertyNames(Object.getPrototypeOf(a))]);
a.enable();
show('a enabled', () => [te.getEnabledCategories(), a.enabled, inspect(a)]);
a.enable();
b.enable();
show('both enabled', () => te.getEnabledCategories());
a.disable();
show('a disabled', () => [te.getEnabledCategories(), a.enabled]);
b.disable();
b.disable();
show('none again', () => te.getEnabledCategories());
for (const [label, o] of [['number', 5], ['no categories', {}], ['string', { categories: 'x' }], ['empty', { categories: [] }], ['element', { categories: ['a', 1] }]]) {
  show(`createTracing ${label}`, () => te.createTracing(o));
}
const many = [];
for (let i = 0; i < 11; i++) {
  const t = te.createTracing({ categories: [`c${i}`] });
  t.enable();
  many.push(t);
}
show('many', () => te.getEnabledCategories());
for (const t of many) t.disable();
