/**
 * The members of Node 22.22.0's `process` that the core of process.mjs
 * doesn't make, as Node has them (names, lengths, enumerable own
 * properties): the internal hooks (`_debugProcess`, `_kill`, `_tickCallback`,
 * `_fatalException`, …), `allowedNodeEnvironmentFlags`, `assert`, `binding`,
 * `debugPort`, `dlopen`, `execve`, `finalization`, `mainModule`,
 * `moduleLoadList`, `openStdin`, `reallyExit`, `report`,
 * `setSourceMapsEnabled` / `sourceMapsEnabled`.
 */
import { getSourceMapsSupport, setSourceMapsSupport } from './source-maps.mjs';
import { SIGNALS } from './signals.mjs';
import { NODE_ENV_FLAGS } from './node-env-flags.mjs';
import {
  ERR_INVALID_ARG_VALUE,
  nodeError,
  validateArray,
  validateBoolean,
  validateObject,
  validateString,
} from './node-errors.mjs';

const define = (process, name, desc) =>
  Object.defineProperty(process, name, {
    enumerable: true,
    configurable: true,
    ...desc,
  });
const method = (process, name, fn, { length = fn.length, fnName = name } = {}) => {
  Object.defineProperty(fn, 'name', { value: fnName });
  Object.defineProperty(fn, 'length', { value: length });
  define(process, name, { value: fn, writable: true });
};

// Linux errnos for the codes kill(2) reports.
const ERRNO = { EPERM: 1, ESRCH: 3, EINVAL: 22 };
const STRERROR = {
  EPERM: 'Operation not permitted',
  ESRCH: 'No such process',
  EINVAL: 'Invalid argument',
};

/** process.allowedNodeEnvironmentFlags: Node's NodeEnvironmentFlagsSet. */
function allowedFlags() {
  const array = NODE_ENV_FLAGS.slice();
  const trimmed = array.map((f) => f.replace(/^--?/, ''));
  let set;
  class NodeEnvironmentFlagsSet extends Set {
    add() {
      return this;
    }
    delete() {
      return false;
    }
    clear() {}
    has(key) {
      if (typeof key !== 'string') return false;
      key = key.replace(/_/g, '-');
      if (/^--?/.test(key)) return array.includes(key.replace(/=.*$/, ''));
      return trimmed.includes(key);
    }
    entries() {
      set ??= new Set(array);
      return set.entries();
    }
    forEach(callback, thisArg = undefined) {
      array.forEach((v) => Reflect.apply(callback, thisArg, [v, v, this]));
    }
    get size() {
      return array.length;
    }
    values() {
      set ??= new Set(array);
      return set.values();
    }
  }
  const values = NodeEnvironmentFlagsSet.prototype.values;
  Object.defineProperty(NodeEnvironmentFlagsSet.prototype, Symbol.iterator, {
    value: values,
  });
  Object.defineProperty(NodeEnvironmentFlagsSet.prototype, 'keys', {
    value: values,
  });
  Object.freeze(NodeEnvironmentFlagsSet.prototype.constructor);
  Object.freeze(NodeEnvironmentFlagsSet.prototype);
  return Object.freeze(new NodeEnvironmentFlagsSet());
}

/**
 * process.binding (DEP0111): the legacy modules Node still answers that
 * jsh has an honest form of (`constants`, `uv`, `util`, `config`); every
 * other name, Node's "No such module".
 */
function legacyBinding(process, name) {
  const builtin = (id) => process._builtin(id);
  switch (name) {
    case 'constants': {
      const os = builtin('os').constants;
      return {
        os,
        fs: builtin('fs').constants,
        crypto: builtin('crypto').constants ?? {},
        zlib: builtin('zlib').constants ?? {},
        // Node 22.22.0's trace-event phases.
        trace: Object.assign(Object.create(null), {
          TRACE_EVENT_PHASE_BEGIN: 66,
          TRACE_EVENT_PHASE_END: 69,
          TRACE_EVENT_PHASE_COMPLETE: 88,
          TRACE_EVENT_PHASE_INSTANT: 73,
          TRACE_EVENT_PHASE_ASYNC_BEGIN: 83,
          TRACE_EVENT_PHASE_ASYNC_STEP_INTO: 84,
          TRACE_EVENT_PHASE_ASYNC_STEP_PAST: 112,
          TRACE_EVENT_PHASE_ASYNC_END: 70,
          TRACE_EVENT_PHASE_NESTABLE_ASYNC_BEGIN: 98,
          TRACE_EVENT_PHASE_NESTABLE_ASYNC_END: 101,
          TRACE_EVENT_PHASE_NESTABLE_ASYNC_INSTANT: 110,
          TRACE_EVENT_PHASE_FLOW_BEGIN: 115,
          TRACE_EVENT_PHASE_FLOW_STEP: 116,
          TRACE_EVENT_PHASE_FLOW_END: 102,
          TRACE_EVENT_PHASE_METADATA: 77,
          TRACE_EVENT_PHASE_COUNTER: 67,
          TRACE_EVENT_PHASE_SAMPLE: 80,
          TRACE_EVENT_PHASE_CREATE_OBJECT: 78,
          TRACE_EVENT_PHASE_SNAPSHOT_OBJECT: 79,
          TRACE_EVENT_PHASE_DELETE_OBJECT: 68,
          TRACE_EVENT_PHASE_MEMORY_DUMP: 118,
          TRACE_EVENT_PHASE_MARK: 82,
          TRACE_EVENT_PHASE_CLOCK_SYNC: 99,
          TRACE_EVENT_PHASE_ENTER_CONTEXT: 40,
          TRACE_EVENT_PHASE_LEAVE_CONTEXT: 41,
          TRACE_EVENT_PHASE_LINK_IDS: 61,
        }),
        internal: Object.assign(Object.create(null), { EXTENSIONLESS_FORMAT_JAVASCRIPT: 0, EXTENSIONLESS_FORMAT_WASM: 1 }),
      };
    }
    case 'uv': {
      const util = builtin('util');
      const out = { errname: (err) => util.getSystemErrorName(err) };
      for (const [errno, [code]] of util.getSystemErrorMap()) out[`UV_${code}`] = errno;
      return out;
    }
    case 'util': {
      const { types } = builtin('util');
      const out = {};
      for (const k of [
        'isArrayBuffer',
        'isAsyncFunction',
        'isDataView',
        'isDate',
        'isExternal',
        'isMap',
        'isMapIterator',
        'isNativeError',
        'isPromise',
        'isRegExp',
        'isSet',
        'isSetIterator',
        'isAnyArrayBuffer',
        'isArrayBufferView',
        'isTypedArray',
        'isUint8Array',
      ]) {
        out[k] = types[k];
      }
      return out;
    }
    case 'config':
      return {
        isDebugBuild: false,
        openSSLIsBoringSSL: false,
        hasOpenSSL: false,
        fipsMode: false,
        hasIntl: true,
        hasTracing: false,
        hasNodeOptions: true,
        hasInspector: false,
        noBrowserGlobals: false,
        bits: 64,
        getDefaultLocale: function getDefaultLocale() {
          return Intl.DateTimeFormat().resolvedOptions().locale;
        },
      };
    default: {
      const err = new Error(`No such module: ${name}`);
      throw err;
    }
  }
}

/** Linux dlopen(3)'s message: jsh loads no native addons. */
function dlopenFailed(process, filename) {
  let exists = false;
  try {
    exists = process._builtin('fs').existsSync(filename);
  } catch {
    /* no fs */
  }
  const reason = exists ? 'invalid ELF header' : 'cannot open shared object file: No such file or directory';
  return nodeError(Error, 'ERR_DLOPEN_FAILED', `${filename}: ${reason}`);
}

/** process.report: Node's API (lib/internal/process/report.js) on jsh's facts. */
function createReport(process) {
  const settings = {
    directory: '',
    filename: '',
    compact: false,
    excludeNetwork: false,
    signal: 'SIGUSR2',
    reportOnFatalError: false,
    reportOnSignal: false,
    reportOnUncaughtException: false,
    excludeEnv: false,
  };
  // The command line's (and NODE_OPTIONS') --report-* options.
  const options = process._options ?? process.execArgv;
  const valueOf = (names) => {
    let value;
    for (let i = 0; i < options.length; i++) {
      const o = options[i];
      for (const name of names) {
        if (o === name) value = options[i + 1];
        else if (o.startsWith(`${name}=`)) value = o.slice(name.length + 1);
      }
    }
    return value;
  };
  const has = (name) => options.includes(name);
  settings.directory = valueOf(['--report-dir', '--report-directory']) ?? settings.directory;
  settings.filename = valueOf(['--report-filename']) ?? settings.filename;
  settings.signal = valueOf(['--report-signal']) ?? settings.signal;
  settings.compact = has('--report-compact');
  settings.excludeNetwork = has('--report-exclude-network');
  settings.excludeEnv = has('--report-exclude-env');
  settings.reportOnFatalError = has('--report-on-fatalerror');
  // Node's --report-signal implies --report-on-signal where it stands: a
  // later --no-report-on-signal turns it off, an earlier one doesn't.
  settings.reportOnSignal = false;
  for (const o of options) {
    if (o === '--report-on-signal' || o === '--report-signal' || o.startsWith('--report-signal=')) settings.reportOnSignal = true;
    else if (o === '--no-report-on-signal') settings.reportOnSignal = false;
  }
  settings.reportOnUncaughtException = has('--report-uncaught-exception');
  let sequence = 0;
  const os = () => process._builtin('os');
  const synthetic = () => {
    const err = nodeError(Error, 'ERR_SYNTHETIC', 'JavaScript Callstack');
    Error.captureStackTrace?.(err, createReport);
    return err;
  };
  /**
   * `jsStack`: an uncaught exception's report as printed (Node's message is
   * its first line, the rest its stack); a signal's report has none.
   */
  const build = (err, event, trigger, filename, jsStack) => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stack = String(err?.stack ?? '')
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('at '));
    const errorProperties = {};
    for (const k of Object.keys(err ?? {}))
      if (k !== 'code' || err.code !== 'ERR_SYNTHETIC') errorProperties[k] = String(err[k]);
    const name = err?.code && err.name === 'Error' ? `${err.name} [${err.code}]` : (err?.name ?? 'Error');
    const mem = process.memoryUsage();
    const ru = process.resourceUsage();
    const o = os();
    return {
      header: {
        reportVersion: 5,
        event,
        trigger,
        filename: filename ?? null,
        dumpEventTime: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}Z`,
        dumpEventTimeStamp: String(now.getTime()),
        processId: process.pid,
        threadId: 0,
        cwd: process.cwd(),
        commandLine: [...(process.argv0 ? [process.argv0] : []), ...process.execArgv, ...process.argv.slice(1)],
        nodejsVersion: process.version,
        // Node's Linux builds (glibc 2.28); jsh follows Linux.
        glibcVersionRuntime: '2.28',
        glibcVersionCompiler: '2.28',
        wordSize: 64,
        arch: process.arch,
        platform: process.platform,
        componentVersions: { ...process.versions },
        release: { ...process.release },
        osName: o.type(),
        osRelease: o.release(),
        osVersion: o.version(),
        osMachine: o.machine(),
        cpus: o.cpus(),
        ...(settings.excludeNetwork
          ? {}
          : {
              networkInterfaces: Object.entries(o.networkInterfaces()).flatMap(([n, list]) =>
                list.map((i) => ({
                  name: n,
                  internal: i.internal,
                  mac: i.mac,
                  address: i.address,
                  netmask: i.netmask,
                  family: i.family,
                })),
              ),
            }),
        host: o.hostname(),
      },
      javascriptStack:
        jsStack !== undefined
          ? { message: jsStack[0] ?? '', ...(jsStack.length > 1 ? { stack: jsStack.slice(1) } : {}), errorProperties }
          : { message: `${name}: ${err?.message ?? ''}`, stack, errorProperties },
      javascriptHeap: {
        totalMemory: mem.heapTotal,
        executableMemory: 0,
        totalCommittedMemory: mem.heapTotal,
        availableMemory: o.freemem(),
        totalGlobalHandlesMemory: 0,
        usedGlobalHandlesMemory: 0,
        usedMemory: mem.heapUsed,
        memoryLimit: process.constrainedMemory?.() || o.totalmem(),
        mallocedMemory: 0,
        externalMemory: mem.external,
        peakMallocedMemory: 0,
        nativeContextCount: 1,
        detachedContextCount: 0,
        doesZapGarbage: 0,
        heapSpaces: {},
      },
      nativeStack: [],
      resourceUsage: {
        free_memory: o.freemem(),
        total_memory: o.totalmem(),
        rss: mem.rss,
        available_memory: o.freemem(),
        userCpuSeconds: ru.userCPUTime / 1e6,
        kernelCpuSeconds: ru.systemCPUTime / 1e6,
        cpuConsumptionPercent: 0,
        userCpuConsumptionPercent: 0,
        kernelCpuConsumptionPercent: 0,
        maxRss: ru.maxRSS * 1024,
        pageFaults: {
          IORequired: ru.majorPageFault,
          IONotRequired: ru.minorPageFault,
        },
        fsActivity: { reads: ru.fsRead, writes: ru.fsWrite },
      },
      uvthreadResourceUsage: {
        userCpuSeconds: ru.userCPUTime / 1e6,
        kernelCpuSeconds: ru.systemCPUTime / 1e6,
        cpuConsumptionPercent: 0,
        userCpuConsumptionPercent: 0,
        kernelCpuConsumptionPercent: 0,
        fsActivity: { reads: ru.fsRead, writes: ru.fsWrite },
      },
      libuv: [],
      workers: [],
      ...(settings.excludeEnv ? {} : { environmentVariables: { ...process.env } }),
      userLimits: {},
      sharedObjects: [],
    };
  };
  /** Writes a report file as Node's TriggerNodeReport does; its name. */
  const write = (file, err, event, trigger, jsStack) => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    sequence++;
    const name =
      file ??
      (settings.filename ||
        `report.${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${process.pid}.0.${String(sequence).padStart(3, '0')}.json`);
    const path = process._builtin('path');
    const target = settings.directory && !path.isAbsolute(name) ? path.join(settings.directory, name) : name;
    const json = build(err, event, trigger, name, jsStack);
    process._rawDebug(`\nWriting Node.js report to file: ${name}`);
    try {
      process._builtin('fs').writeFileSync(target, `${JSON.stringify(json, null, settings.compact ? 0 : 2)}\n`);
      process._rawDebug('Node.js report completed');
    } catch (e) {
      process._rawDebug(`Failed to open Node.js report file: ${name} directory: ${settings.directory || '.'} (errno: ${Math.abs(e?.errno ?? 2)})`);
    }
    return name;
  };
  // The runtime's hooks: an uncaught exception's report (its printed text),
  // and the report signal (process.mjs delivers it, as Node's handler does).
  Object.defineProperty(process, '_reportUncaught', {
    value: (err, printed) => {
      if (!settings.reportOnUncaughtException) return;
      const lines = String(printed).replace(/\n+$/, '').split('\n').map((l) => l.trim());
      write(undefined, err, 'Exception', 'Exception', lines);
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
  const signalHook = () => {
    process._setReportSignal(settings.reportOnSignal ? settings.signal : null, () =>
      write(undefined, undefined, settings.signal, 'Signal', [''])
    );
  };
  const report = {
    writeReport(file, err) {
      if (typeof file === 'object' && file !== null) {
        err = file;
        file = undefined;
      } else if (file !== undefined) {
        validateString(file, 'file');
      }
      if (err === undefined) err = synthetic();
      else validateObject(err, 'err');
      return write(file, err, 'JavaScript API', 'API');
    },
    getReport(err) {
      if (err === undefined) err = synthetic();
      else validateObject(err, 'err');
      return build(err, 'JavaScript API', 'GetReport');
    },
  };
  for (const [key, check] of [
    ['directory', validateString],
    ['filename', validateString],
    ['compact', validateBoolean],
    ['excludeNetwork', validateBoolean],
    [
      'signal',
      (v, n) => {
        validateString(v, n);
        if (!(v in SIGNALS)) throw nodeError(TypeError, 'ERR_UNKNOWN_SIGNAL', `Unknown signal: ${v}`);
      },
    ],
    ['reportOnFatalError', (v) => validateBoolean(v, 'trigger')],
    ['reportOnSignal', (v) => validateBoolean(v, 'trigger')],
    ['reportOnUncaughtException', (v) => validateBoolean(v, 'trigger')],
    ['excludeEnv', validateBoolean],
  ]) {
    Object.defineProperty(report, key, {
      enumerable: true,
      configurable: true,
      get: () => settings[key],
      set(value) {
        check(value, key);
        settings[key] = value;
        if (key === 'reportOnSignal' || key === 'signal') signalHook();
      },
    });
  }
  // --report-on-signal: its signal watched from the start.
  if (settings.reportOnSignal) signalHook();
  return report;
}

/**
 * Installs them on `process`. `deps`: the tick queue (`flushTicks`), the
 * uncaught-exception path (`handleUncaught`), the -r list (`preload`).
 */
export function installProcessMembers(process, { flushTicks, handleUncaught, preload = [] } = {}) {
  method(process, '_debugEnd', function () {}, { length: 0 });
  method(
    process,
    '_debugProcess',
    function (pid) {
      try {
        process.kill(pid, 'SIGUSR1');
      } catch (e) {
        const code = e?.code in ERRNO ? e.code : 'ESRCH';
        const err = new Error(`${code}, ${STRERROR[code]}`);
        Object.assign(err, { errno: ERRNO[code], code, syscall: 'kill' });
        throw err;
      }
    },
    { length: 0 },
  );
  method(process, '_startProfilerIdleNotifier', function () {}, { fnName: '' });
  method(process, '_stopProfilerIdleNotifier', function () {}, { fnName: '' });
  // Node's onGlobalUncaughtException: true when something took the error.
  method(
    process,
    '_fatalException',
    function (er, fromPromise) {
      return Boolean(handleUncaught?.(er, fromPromise ? 'unhandledRejection' : 'uncaughtException'));
    },
    { fnName: '' },
  );
  // The binding under process.kill: 0, or a negative errno.
  method(
    process,
    '_kill',
    function (pid, sig) {
      try {
        process.kill(pid | 0, sig | 0);
        return 0;
      } catch (e) {
        if (e?.name === 'NodeExitError' || e?.code === 'ERR_JSH_EXIT') throw e;
        return typeof e?.errno === 'number' ? -Math.abs(e.errno) : -ERRNO.ESRCH;
      }
    },
    { length: 0 },
  );
  method(process, '_linkedBinding', function (name) {
    throw nodeError(Error, 'ERR_INVALID_MODULE', `No such binding was linked: ${name}`);
  });
  define(process, '_preload_modules', {
    value: preload.slice(),
    writable: false,
  });
  method(
    process,
    '_tickCallback',
    function () {
      flushTicks?.();
    },
    { fnName: 'runNextTicks' },
  );

  let flags;
  define(process, 'allowedNodeEnvironmentFlags', {
    get() {
      return (flags ??= allowedFlags());
    },
    set(value) {
      Object.defineProperty(this, 'allowedNodeEnvironmentFlags', {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    },
  });

  let assertWarned = false;
  method(
    process,
    'assert',
    function (x, msg) {
      if (!assertWarned && !process.noDeprecation) {
        assertWarned = true;
        process.emitWarning(
          'process.assert() is deprecated. Please use the `assert` module instead.',
          'DeprecationWarning',
          'DEP0100',
          process.assert,
        );
      }
      if (!x) throw nodeError(Error, 'ERR_ASSERTION', msg || 'assertion error');
    },
    { fnName: 'deprecated', length: 2 },
  );
  method(process, 'binding', function binding(module) {
    return legacyBinding(process, String(module));
  });
  define(process, 'debugPort', { value: 9229, writable: true });
  method(
    process,
    'dlopen',
    function (module, filename) {
      if (arguments.length < 2) {
        throw nodeError(TypeError, 'ERR_MISSING_ARGS', 'process.dlopen needs at least 2 arguments');
      }
      // Node reads module.exports first (ToObject).
      if (module == null || module.exports == null) throw new TypeError('Cannot convert undefined or null to object');
      throw dlopenFailed(process, String(filename));
    },
    { length: 0 },
  );

  let execveWarned = false;
  method(process, 'execve', function execve(execPath, args = [], env = process.env) {
    if (!execveWarned) {
      execveWarned = true;
      process.emitWarning(
        'process.execve is an experimental feature and might change at any time',
        'ExperimentalWarning',
      );
    }
    validateString(execPath, 'execPath');
    validateArray(args, 'args');
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (typeof arg !== 'string' || arg.includes('\u0000')) {
        throw ERR_INVALID_ARG_VALUE(`args[${i}]`, arg, 'must be a string without null bytes');
      }
    }
    validateObject(env, 'env');
    const childEnv = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof key !== 'string' || typeof value !== 'string' || key.includes('\u0000') || value.includes('\u0000')) {
        throw ERR_INVALID_ARG_VALUE('env', env, 'must be an object with string keys and values without null bytes');
      }
      childEnv[key] = value;
    }
    return process._execve(execPath, args, childEnv);
  });

  let finalization;
  define(process, 'finalization', {
    get() {
      return (finalization ??= process._nodeLib().finalization.createFinalization());
    },
    set(value) {
      Object.defineProperty(this, 'finalization', {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    },
  });
  define(process, 'mainModule', { value: undefined, writable: true });
  define(process, 'moduleLoadList', { value: [], writable: false });
  method(
    process,
    'openStdin',
    function () {
      process.stdin.resume();
      return process.stdin;
    },
    { fnName: '' },
  );
  method(
    process,
    'reallyExit',
    function (code) {
      return process._reallyExit(code);
    },
    { length: 0 },
  );
  let report;
  define(process, 'report', {
    get() {
      return (report ??= createReport(process));
    },
  });
  // Node's bootstrap/node.js: both on lib/internal/source_map's support.
  method(process, 'setSourceMapsEnabled', function setSourceMapsEnabled(val) {
    setSourceMapsSupport(val, { __proto__: null, nodeModules: val, generatedCode: val });
  });
  define(process, 'sourceMapsEnabled', {
    get() {
      return getSourceMapsSupport().enabled;
    },
  });
}
