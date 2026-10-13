// sys, repl, diagnostics_channel, perf_hooks, stream/web, stream/consumers
// and domain, against host Node.
const t = async (l, f) => {
  try {
    console.log(l, JSON.stringify(await f()));
  } catch (e) {
    console.log(l, 'THROWS', e.name, e.code, e.message);
  }
};
const keys = (m) => Object.keys(require(m)).sort();
(async () => {
  for (const m of ['perf_hooks', 'stream/web', 'stream/consumers', 'diagnostics_channel', 'domain', 'repl']) await t(`${m} keys`, () => keys(m));
  await t('builtins', () => ['sys', 'repl', 'domain', 'perf_hooks', 'diagnostics_channel', 'stream/web', 'stream/consumers'].map((m) => [require('module').isBuiltin(m), require('module').builtinModules.includes(m)]));
  // sys: util itself, with DEP0025 (its 'warning'; run with --no-warnings)
  const warnings = [];
  process.on('warning', (w) => warnings.push([w.name, w.code]));
  await t('sys is util', () => [require('sys') === require('util'), require('node:sys') === require('util')]);

  // perf_hooks
  const { createHistogram, monitorEventLoopDelay, performance, constants, PerformanceObserver } = require('perf_hooks');
  await t('performance', () => [performance === globalThis.performance, typeof performance.now(), typeof PerformanceObserver, constants.NODE_PERFORMANCE_GC_MAJOR, constants.NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE, Object.keys(constants).length]);
  const h = createHistogram();
  await t('empty histogram', () => [h.min, h.max, h.mean, h.stddev, h.count, h.exceeds, [...h.percentiles], h.percentile(50), String(h.minBigInt), String(h.countBigInt)]);
  for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) h.record(v);
  await t('histogram', () => [h.min, h.max, h.mean, h.stddev, h.count, h.percentile(50), h.percentile(90), h.percentile(100), [...h.percentiles], h.toJSON()]);
  for (const v of [0, 1.5, 'x']) await t(`record ${JSON.stringify(v)}`, () => h.record(v));
  await t('record 0n', () => h.record(0n));
  await t('percentile 0', () => h.percentile(0));
  const h2 = createHistogram({ lowest: 1, highest: 100, figures: 2 });
  h2.record(1000);
  h2.record(7);
  await t('exceeds', () => [h2.count, h2.exceeds, h2.max]);
  const h3 = createHistogram();
  h3.record(5n);
  h3.record(5);
  await t('add / reset', () => { const a = [String(h3.percentileBigInt(50)), [...h3.percentiles]]; h.add(h3); const b = [h.count, h.max]; h.reset(); return [a, b, h.count, h.min]; });
  for (const o of [{ lowest: 0 }, { highest: 1 }, { figures: 6 }, { lowest: 'x' }]) await t(`createHistogram ${JSON.stringify(o)}`, () => createHistogram(o));
  const m = monitorEventLoopDelay({ resolution: 10 });
  await t('monitorEventLoopDelay', () => [m.enable(), m.enable(), m.disable(), m.disable(), typeof m.count, Object.getPrototypeOf(m).constructor.name]);
  await t('monitorEventLoopDelay resolution 0', () => monitorEventLoopDelay({ resolution: 0 }));
  await t('inspect', () => require('util').inspect(createHistogram()));

  // diagnostics_channel
  const dc = require('diagnostics_channel');
  const seen = [];
  const ch = dc.channel('jsh:test');
  const fn = (msg, name) => seen.push([msg, name]);
  await t('channel', () => { const before = ch.hasSubscribers; dc.subscribe('jsh:test', fn); ch.publish({ a: 1 }); const r = [before, ch.hasSubscribers, dc.hasSubscribers('jsh:test'), dc.channel('jsh:test') === ch, seen]; dc.unsubscribe('jsh:test', fn); return [...r, ch.hasSubscribers]; });
  await t('tracingChannel', () => { const tc = dc.tracingChannel('jsh:trace'); const ev = []; tc.subscribe({ start: () => ev.push('start'), end: () => ev.push('end'), asyncStart: () => {}, asyncEnd: () => {}, error: () => ev.push('error') }); const r = tc.traceSync(() => 42, {}); return [r, ev]; });

  // stream/web, stream/consumers
  const web = require('stream/web');
  await t('stream/web', () => [web.ReadableStream === globalThis.ReadableStream, typeof web.TextDecoderStream, typeof web.CompressionStream]);
  const { text, json, buffer, arrayBuffer, blob } = require('stream/consumers');
  const { Readable } = require('stream');
  await t('consumers', async () => [await text(Readable.from(['a', 'b'])), await json(Readable.from(['{"k":', '1}'])), (await buffer(Readable.from([Buffer.from('xy')]))).toString(), (await arrayBuffer(Readable.from([Buffer.from('z')]))).byteLength, (await blob(Readable.from(['blob']))).size, await text(new web.ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('web')); c.close(); } }))]);

  // domain: errors from a tick, a timer and an emitter made in run(), and intercept()
  const domain = require('domain');
  const d = domain.create();
  const caught = [];
  d.on('error', (e) => caught.push(e.message));
  d.run(() => {
    process.nextTick(() => { throw new Error('tick'); });
    setTimeout(() => { throw new Error('timer'); }, 5);
    const { EventEmitter } = require('events');
    const e = new EventEmitter();
    setTimeout(() => e.emit('error', new Error('emitter')), 15);
  });
  d.intercept(() => {})(new Error('intercepted'));
  await new Promise((r) => setTimeout(r, 40));
  await t('domain', () => [caught, d.members, typeof domain.Domain, d instanceof require('events')]);

  // repl: the module (a REPL over streams, not the terminal)
  const repl = require('repl');
  const { PassThrough } = require('stream');
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', (c) => { out += c; });
  const r = repl.start({ input, output, prompt: '$ ', terminal: false, useColors: false });
  r.context.fromOutside = 20;
  input.end('fromOutside + 1\nconst z = [1, 2]\nz.length\n');
  await new Promise((res) => r.on('exit', res));
  await t('repl.start', () => [out, typeof repl.REPLServer, repl.REPL_MODE_STRICT === repl.REPL_MODE_SLOPPY]);
  await t('warnings', () => warnings);
})();
