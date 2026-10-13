/**
 * perf_hooks: the platform's Performance API (the program's `performance`,
 * PerformanceObserver, PerformanceEntry and its kinds, as Node exports them),
 * Node's constants, and the histograms of lib/internal/histogram.js written
 * in JS (Node's are HDR histograms in C++: here every value is counted exactly,
 * so percentiles of values past 2047 are exact where Node's are rounded to
 * its 3 significant figures).
 *
 * monitorEventLoopDelay samples with an unref'd timer every `resolution` ms
 * and records how late it fired (ns), as Node's ELDHistogram does with its
 * uv timer.
 */
import { ERR_INVALID_ARG_TYPE, ERR_OUT_OF_RANGE, nodeError, validateObject } from '../node-errors.mjs';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const kInspect = Symbol.for('nodejs.util.inspect.custom');

const CONSTANTS = Object.freeze({
  __proto__: null,
  NODE_PERFORMANCE_GC_MAJOR: 4,
  NODE_PERFORMANCE_GC_MINOR: 1,
  NODE_PERFORMANCE_GC_INCREMENTAL: 8,
  NODE_PERFORMANCE_GC_WEAKCB: 16,
  NODE_PERFORMANCE_GC_FLAGS_NO: 0,
  NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED: 2,
  NODE_PERFORMANCE_GC_FLAGS_FORCED: 4,
  NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING: 8,
  NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE: 16,
  NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY: 32,
  NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE: 64,
});

/** Node's validateInteger with its ERR_OUT_OF_RANGE / ERR_INVALID_ARG_TYPE. */
function intIn(value, name, min, max = MAX_SAFE) {
  if (typeof value !== 'number') throw ERR_INVALID_ARG_TYPE(name, 'number', value);
  if (!Number.isInteger(value)) throw ERR_OUT_OF_RANGE(name, 'an integer', value);
  if (value < min || value > max) throw ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
  return value;
}

const kState = Symbol('kState');

class Histogram {
  constructor(state) {
    this[kState] = state;
  }
  get count() {
    return this[kState].count;
  }
  get countBigInt() {
    return BigInt(this[kState].count);
  }
  get min() {
    const s = this[kState];
    return s.count ? s.min : 9223372036854776000;
  }
  get minBigInt() {
    const s = this[kState];
    return s.count ? BigInt(s.min) : 9223372036854775807n;
  }
  get max() {
    return this[kState].count ? this[kState].max : 0;
  }
  get maxBigInt() {
    return BigInt(this.max);
  }
  get mean() {
    const s = this[kState];
    return s.count ? s.sum / s.count : NaN;
  }
  get stddev() {
    const s = this[kState];
    if (!s.count) return NaN;
    const mean = s.sum / s.count;
    let sq = 0;
    for (const [v, c] of s.counts) sq += c * (v - mean) ** 2;
    return Math.sqrt(sq / s.count);
  }
  get exceeds() {
    return this[kState].exceeds;
  }
  get exceedsBigInt() {
    return BigInt(this[kState].exceeds);
  }
  /** hdr_value_at_percentile. */
  percentile(percentile) {
    if (typeof percentile !== 'number') throw ERR_INVALID_ARG_TYPE('percentile', 'number', percentile);
    if (!(percentile > 0 && percentile <= 100)) throw ERR_OUT_OF_RANGE('percentile', '> 0 && <= 100', percentile);
    const s = this[kState];
    const wanted = Math.max(1, Math.floor((percentile / 100) * s.count + 0.5));
    let seen = 0;
    for (const v of sortedValues(s)) {
      seen += s.counts.get(v);
      if (seen >= wanted) return v;
    }
    return 0;
  }
  percentileBigInt(percentile) {
    return BigInt(this.percentile(percentile));
  }
  /** hdr's percentile iterator (one tick per half distance), as Node fills the map. */
  get percentiles() {
    const map = new Map();
    const s = this[kState];
    let cumulative = 0;
    let to = 0;
    let last = 0;
    for (const v of sortedValues(s)) {
      cumulative += s.counts.get(v);
      last = v;
      if (cumulative === s.count) {
        // The last value: its tick if reached, then 100.
        if ((100 * cumulative) / s.count >= to && to < 100) map.set(to, v);
        break;
      }
      while ((100 * cumulative) / s.count >= to) {
        map.set(to, v);
        to += 100 / 2 ** (Math.trunc(Math.log2(100 / (100 - to))) + 1);
      }
    }
    map.set(100, last);
    return map;
  }
  get percentilesBigInt() {
    const map = new Map();
    for (const [k, v] of this.percentiles) map.set(k, BigInt(v));
    return map;
  }
  reset() {
    const s = this[kState];
    s.counts.clear();
    s.count = 0;
    s.sum = 0;
    s.min = Infinity;
    s.max = 0;
    s.exceeds = 0;
    s.sorted = null;
  }
  toJSON() {
    return {
      count: this.count,
      min: this.min,
      max: this.max,
      mean: this.mean,
      exceeds: this.exceeds,
      stddev: this.stddev,
      percentiles: Object.fromEntries(this.percentiles),
    };
  }
  [kInspect](depth, options, inspect) {
    if (depth < 0) return this;
    const opts = { ...options, depth: options.depth == null ? null : options.depth - 1 };
    const fields = {
      min: this.min,
      max: this.max,
      mean: this.mean,
      exceeds: this.exceeds,
      stddev: this.stddev,
      count: this.count,
      percentiles: this.percentiles,
    };
    return `Histogram ${inspect(fields, opts)}`;
  }
}

function sortedValues(s) {
  s.sorted ??= [...s.counts.keys()].sort((a, b) => a - b);
  return s.sorted;
}

function newState(lowest = 1, highest = MAX_SAFE) {
  return { counts: new Map(), count: 0, sum: 0, min: Infinity, max: 0, exceeds: 0, lowest, highest, sorted: null, prevDelta: undefined };
}

function recordInto(s, value) {
  if (value > s.highest) {
    s.exceeds++;
    return;
  }
  s.counts.set(value, (s.counts.get(value) ?? 0) + 1);
  s.sorted = null;
  s.count++;
  s.sum += value;
  if (value < s.min) s.min = value;
  if (value > s.max) s.max = value;
}

class RecordableHistogram extends Histogram {
  constructor(state) {
    super(state);
  }
  record(val) {
    if (typeof val === 'bigint') {
      // Node's C++ check, with its own short message (and no upper bound).
      if (val < 1n) throw nodeError(RangeError, 'ERR_OUT_OF_RANGE', 'value is out of range');
      val = Number(val);
    } else {
      intIn(val, 'val', 1);
    }
    recordInto(this[kState], val);
  }
  /** The nanoseconds since its last call (the first call only starts the clock). */
  recordDelta() {
    const s = this[kState];
    const now = process.hrtime.bigint();
    if (s.prevDelta !== undefined) recordInto(s, Math.max(1, Number(now - s.prevDelta)));
    s.prevDelta = now;
  }
  add(other) {
    if (!(other instanceof RecordableHistogram)) throw ERR_INVALID_ARG_TYPE('other', 'RecordableHistogram', other);
    const s = this[kState];
    const o = other[kState];
    for (const [v, c] of o.counts) for (let i = 0; i < c; i++) recordInto(s, v);
    s.exceeds += o.exceeds;
  }
}

class ELDHistogram extends Histogram {
  #timer = null;
  #resolution;
  constructor(state, resolution) {
    super(state);
    this.#resolution = resolution;
  }
  enable() {
    if (this.#timer) return false;
    let expected = performance.now() + this.#resolution;
    this.#timer = setInterval(() => {
      const now = performance.now();
      recordInto(this[kState], Math.max(1, Math.round((now - expected) * 1e6)));
      expected = now + this.#resolution;
    }, this.#resolution);
    this.#timer.unref?.();
    return true;
  }
  disable() {
    if (!this.#timer) return false;
    clearInterval(this.#timer);
    this.#timer = null;
    return true;
  }
}

function createHistogram(options = {}) {
  validateObject(options, 'options');
  const { lowest = 1, highest = MAX_SAFE, figures = 3 } = options;
  if (typeof lowest !== 'bigint') intIn(lowest, 'options.lowest', 1);
  if (typeof highest !== 'bigint') intIn(highest, 'options.highest', 2 * Number(lowest));
  intIn(figures, 'options.figures', 1, 5);
  return new RecordableHistogram(newState(Number(lowest), Number(highest)));
}

function monitorEventLoopDelay(options = {}) {
  validateObject(options, 'options');
  const { resolution = 10 } = options;
  intIn(resolution, 'options.resolution', 1);
  return new ELDHistogram(newState(), resolution);
}

export function createPerfHooks() {
  const perf = globalThis.performance;
  return {
    Performance: perf ? Object.getPrototypeOf(perf).constructor : undefined,
    PerformanceEntry: globalThis.PerformanceEntry,
    PerformanceMark: globalThis.PerformanceMark,
    PerformanceMeasure: globalThis.PerformanceMeasure,
    PerformanceObserver: globalThis.PerformanceObserver,
    PerformanceObserverEntryList: globalThis.PerformanceObserverEntryList,
    PerformanceResourceTiming: globalThis.PerformanceResourceTiming,
    monitorEventLoopDelay,
    createHistogram,
    performance: perf,
    constants: CONSTANTS,
  };
}

/** stream/web: the platform's WHATWG streams, under Node's names. */
export function createStreamWeb() {
  const names = [
    'ReadableStream',
    'ReadableStreamDefaultReader',
    'ReadableStreamBYOBReader',
    'ReadableStreamBYOBRequest',
    'ReadableByteStreamController',
    'ReadableStreamDefaultController',
    'TransformStream',
    'TransformStreamDefaultController',
    'WritableStream',
    'WritableStreamDefaultWriter',
    'WritableStreamDefaultController',
    'ByteLengthQueuingStrategy',
    'CountQueuingStrategy',
    'TextEncoderStream',
    'TextDecoderStream',
    'CompressionStream',
    'DecompressionStream',
  ];
  const out = {};
  for (const n of names) out[n] = globalThis[n];
  return out;
}
