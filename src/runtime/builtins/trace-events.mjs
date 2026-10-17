/**
 * node:trace_events — Node 22.22.0's lib/trace_events.js. A Tracing object
 * enables and disables its categories, and getEnabledCategories() reports
 * the enabled set as Node's agent does. jsh has no trace agent, so no trace
 * file is written.
 */
import { inspect } from 'node-inspect-extracted';
import { ERR_INVALID_ARG_TYPE, nodeError, validateObject } from '../node-errors.mjs';

const kMaxTracingCount = 10;

export function createTraceEvents({ process }) {
  const enabledTracingObjects = new Set();
  const fromCli = () => {
    const argv = process?._options ?? process?.execArgv ?? [];
    let value;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--trace-event-categories') value = argv[++i];
      else if (argv[i].startsWith('--trace-event-categories=')) value = argv[i].slice('--trace-event-categories='.length);
    }
    return value ? value.split(',').filter(Boolean) : [];
  };

  class Tracing {
    #categories;
    #enabled = false;

    constructor(categories) {
      this.#categories = categories;
    }

    enable() {
      if (!this.#enabled) {
        this.#enabled = true;
        enabledTracingObjects.add(this);
        if (enabledTracingObjects.size > kMaxTracingCount) {
          process?.emitWarning?.(
            `Possible trace_events memory leak detected. There are more than ${kMaxTracingCount} enabled Tracing objects.`
          );
        }
      }
    }

    disable() {
      if (this.#enabled) {
        this.#enabled = false;
        enabledTracingObjects.delete(this);
      }
    }

    get enabled() {
      return this.#enabled;
    }

    get categories() {
      return this.#categories.join(',');
    }

    [Symbol.for('nodejs.util.inspect.custom')](depth, opts) {
      if (typeof depth === 'number' && depth < 0) return this;
      void opts;
      return `Tracing ${inspect({ enabled: this.enabled, categories: this.categories })}`;
    }
  }

  function createTracing(options) {
    validateObject(options, 'options');
    const categories = options.categories;
    if (!Array.isArray(categories)) throw ERR_INVALID_ARG_TYPE('options.categories', 'Array', categories);
    for (let i = 0; i < categories.length; i++) {
      if (typeof categories[i] !== 'string') {
        throw ERR_INVALID_ARG_TYPE(`options.categories[${i}]`, 'string', categories[i]);
      }
    }
    if (categories.length <= 0) {
      throw nodeError(TypeError, 'ERR_TRACE_EVENTS_CATEGORY_REQUIRED', 'At least one category is required');
    }
    return new Tracing(categories);
  }

  /** The agent's set: every enabled category, sorted, once each; undefined when none. */
  function getEnabledCategories() {
    const all = new Set(fromCli());
    for (const t of enabledTracingObjects) for (const c of t.categories.split(',')) all.add(c);
    return all.size ? [...all].sort().join(',') : undefined;
  }

  return { createTracing, getEnabledCategories };
}
