/**
 * The `internalBinding(name)` that Node's own lib files in src/node-lib see:
 * what Node's C++ gives them, made here over the kernel process (its env,
 * uid/gid) and the platform. Only what those files ask for.
 */
import nodeInspect from 'node-inspect-extracted';
import { SIGNALS } from './signals.mjs';

const proc = () => globalThis.process;
const env = () => proc()?.env ?? {};

/** Linux errno values (node_constants.cc DefineErrnoConstants, Linux). */
export const ERRNO = {
  E2BIG: 7, EACCES: 13, EADDRINUSE: 98, EADDRNOTAVAIL: 99, EAFNOSUPPORT: 97, EAGAIN: 11,
  EALREADY: 114, EBADF: 9, EBADMSG: 74, EBUSY: 16, ECANCELED: 125, ECHILD: 10,
  ECONNABORTED: 103, ECONNREFUSED: 111, ECONNRESET: 104, EDEADLK: 35, EDESTADDRREQ: 89,
  EDOM: 33, EDQUOT: 122, EEXIST: 17, EFAULT: 14, EFBIG: 27, EHOSTUNREACH: 113, EIDRM: 43,
  EILSEQ: 84, EINPROGRESS: 115, EINTR: 4, EINVAL: 22, EIO: 5, EISCONN: 106, EISDIR: 21,
  ELOOP: 40, EMFILE: 24, EMLINK: 31, EMSGSIZE: 90, EMULTIHOP: 72, ENAMETOOLONG: 36,
  ENETDOWN: 100, ENETRESET: 102, ENETUNREACH: 101, ENFILE: 23, ENOBUFS: 105, ENODATA: 61,
  ENODEV: 19, ENOENT: 2, ENOEXEC: 8, ENOLCK: 37, ENOLINK: 67, ENOMEM: 12, ENOMSG: 42,
  ENOPROTOOPT: 92, ENOSPC: 28, ENOSR: 63, ENOSTR: 60, ENOSYS: 38, ENOTCONN: 107,
  ENOTDIR: 20, ENOTEMPTY: 39, ENOTSOCK: 88, ENOTSUP: 95, ENOTTY: 25, ENXIO: 6,
  EOPNOTSUPP: 95, EOVERFLOW: 75, EPERM: 1, EPIPE: 32, EPROTO: 71, EPROTONOSUPPORT: 93,
  EPROTOTYPE: 91, ERANGE: 34, EROFS: 30, ESPIPE: 29, ESRCH: 3, ESTALE: 116, ETIME: 62,
  ETIMEDOUT: 110, ETXTBSY: 26, EWOULDBLOCK: 11, EXDEV: 18,
};

/** os.constants (Linux): what Node 22.22.0 has there. Made on first use (SIGNALS is process.mjs's). */
let osConstants;
function getOsConstants() {
  if (osConstants) return osConstants;
  osConstants = {
    UV_UDP_REUSEADDR: 4,
    dlopen: { RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_GLOBAL: 256, RTLD_LOCAL: 0, RTLD_DEEPBIND: 8 },
    errno: { ...ERRNO },
    signals: { ...SIGNALS },
    priority: {
      PRIORITY_LOW: 19,
      PRIORITY_BELOW_NORMAL: 10,
      PRIORITY_NORMAL: 0,
      PRIORITY_ABOVE_NORMAL: -7,
      PRIORITY_HIGH: -14,
      PRIORITY_HIGHEST: -20,
    },
  };
  return osConstants;
}

const cpuCount = () => {
  const n = Number(globalThis.navigator?.hardwareConcurrency);
  return Number.isInteger(n) && n > 0 ? n : 1;
};

/** uv_os_tmpdir: TMPDIR, TMP, TEMP, TEMPDIR, else /tmp; no trailing slash. */
function tmpDir() {
  const e = env();
  for (const k of ['TMPDIR', 'TMP', 'TEMP', 'TEMPDIR']) {
    const v = e[k];
    if (typeof v === 'string' && v !== '') return v.length > 1 && v.endsWith('/') ? v.slice(0, -1) : v;
  }
  return undefined;
}

function passwdEntry(uid) {
  try {
    const text = new TextDecoder().decode(proc()._ctx.sync.fs.readFile('/etc/passwd'));
    for (const line of text.split('\n')) {
      const f = line.split(':');
      if (f.length >= 7 && Number(f[2]) === uid) return { name: f[0], gid: Number(f[3]), home: f[5], shell: f[6] };
    }
  } catch {
    /* no passwd */
  }
  return undefined;
}

function homeDir() {
  const h = env().HOME;
  if (typeof h === 'string' && h !== '') return h;
  const pw = passwdEntry(proc()?.getuid?.() ?? 0);
  return pw?.home ?? '/';
}

const startedAt = Date.now() - 1000;
const ownPid = (pid) => pid === 0 || pid === proc()?.pid;
function esrch(ctx, syscall) {
  if (ctx) Object.assign(ctx, { errno: -3, code: 'ESRCH', message: 'no such process', syscall });
}
const priorities = new Map();

const bindings = {
  credentials: {
    getTempDir: tmpDir,
    safeGetenv: (name) => env()[name],
  },
  constants: {
    get os() {
      return getOsConstants();
    },
  },
  os: {
    getHostname: () => 'slicc',
    getOSInformation: () => ['Linux', '#1 SMP', '6.0.0-slicc', 'x86_64'],
    getHomeDirectory: homeDir,
    getUptime: () => Math.floor((Date.now() - startedAt) / 1000),
    getTotalMem: () => 8 * 1024 * 1024 * 1024,
    getFreeMem: () => 4 * 1024 * 1024 * 1024,
    getAvailableParallelism: cpuCount,
    getCPUs() {
      const out = [];
      for (let i = 0; i < cpuCount(); i++) out.push('virtual', 0, 0, 0, 0, 0, 0);
      return out;
    },
    getLoadAvg(array) {
      array[0] = 0;
      array[1] = 0;
      array[2] = 0;
    },
    // The kernel's loopback (its only interface).
    getInterfaceAddresses: () => ['lo', '127.0.0.1', '255.0.0.0', 'IPv4', '00:00:00:00:00:00', true, -1],
    getUserInfo(options) {
      // uv_os_get_passwd: the kernel's /etc/passwd entry for the uid.
      const p = proc();
      const e = env();
      const uid = p?.getuid?.() ?? 0;
      const pw = passwdEntry(uid);
      const gid = pw?.gid ?? p?.getgid?.() ?? 0;
      const username = pw?.name ?? (e.USER || e.LOGNAME || (uid === 0 ? 'root' : 'user'));
      const info = { uid, gid, username, homedir: pw?.home ?? homeDir(), shell: pw?.shell ?? (e.SHELL || '/bin/sh') };
      if (options?.encoding === 'buffer') {
        const B = p?._Buffer ?? globalThis.Buffer;
        if (B) {
          info.username = B.from(info.username);
          info.homedir = B.from(info.homedir);
          if (info.shell !== null) info.shell = B.from(info.shell);
        }
      }
      return info;
    },
    // Only this process (pid 0 or its own) can be asked about; others are
    // ESRCH, as libuv answers for a pid that doesn't exist.
    getPriority(pid, ctx) {
      if (!ownPid(pid)) return void esrch(ctx, 'uv_os_getpriority');
      return priorities.get(0) ?? 0;
    },
    setPriority(pid, priority, ctx) {
      if (!ownPid(pid)) {
        esrch(ctx, 'uv_os_setpriority');
        return -3;
      }
      priorities.set(0, priority);
      return 0;
    },
    isBigEndian: false,
  },
  // The REPL's ^C watchdog (breakEvalOnSigint): a running script can't be
  // interrupted here, so it starts (nothing to watch) and has seen no SIGINT.
  contextify: {
    startSigintWatchdog: () => true,
    stopSigintWatchdog: () => false,
  },
  util: {
    // punycode's deprecation check (DEP0040): a caller under node_modules.
    isInsideNodeModules() {
      const holder = {};
      Error.captureStackTrace(holder);
      const lines = String(holder.stack).split('\n').slice(3);
      return lines.some((l) => l.includes('/node_modules/') && !l.includes('@ai-ecoverse/slicc-jsh'));
    },
  },
};

/** What a Node lib file's `internalBinding(name)` returns. */
export function internalBinding(name) {
  const b = bindings[name];
  if (b === undefined) throw new Error(`No such binding: ${name}`);
  return b;
}

/** For bindings that need runtime pieces made later (url). */
export function setBinding(name, value) {
  bindings[name] = value;
}

// --- util binding -----------------------------------------------------------

/** src/node_dotenv.cc Dotenv::ParseContent (Node 22.22.0), into a std::map (sorted keys). */
function parseEnv(input) {
  const store = new Map();
  const trim = (s) => s.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
  let content = trim(input.replace(/\r/g, ''));
  while (content.length) {
    if (content[0] === '\n' || content[0] === '#') {
      const nl = content.indexOf('\n');
      content = nl === -1 ? '' : content.slice(nl + 1);
      continue;
    }
    const eqnl = content.search(/[=\n]/);
    if (eqnl === -1 || content[eqnl] === '\n') {
      if (eqnl !== -1) {
        content = trim(content.slice(eqnl + 1));
        continue;
      }
      break;
    }
    let key = trim(content.slice(0, eqnl));
    content = content.slice(eqnl + 1);
    if (!content.length || content[0] === '\n') {
      store.set(key, '');
      continue;
    }
    content = trim(content);
    if (!key) continue;
    if (key.startsWith('export ')) key = trim(key.slice(7));
    if (!content.length) {
      store.set(key, '');
      break;
    }
    if (content[0] === '"') {
      const close = content.indexOf('"', 1);
      if (close !== -1) {
        store.set(key, content.slice(1, close).split('\\n').join('\n'));
        const nl = content.indexOf('\n', close + 1);
        content = nl === -1 ? '' : content.slice(nl + 1);
        continue;
      }
    }
    if (content[0] === "'" || content[0] === '"' || content[0] === '`') {
      const close = content.indexOf(content[0], 1);
      if (close === -1) {
        const nl = content.indexOf('\n');
        if (nl !== -1) {
          store.set(key, content.slice(0, nl));
          content = content.slice(nl + 1);
        } else {
          store.set(key, content);
          break;
        }
      } else {
        store.set(key, content.slice(1, close));
        const nl = content.indexOf('\n', close + 1);
        content = nl === -1 ? '' : content.slice(nl + 1);
        continue;
      }
    } else {
      const nl = content.indexOf('\n');
      let value = nl === -1 ? content : content.slice(0, nl);
      const hash = value.indexOf('#');
      if (hash !== -1) value = value.slice(0, hash);
      store.set(key, trim(value));
      if (nl === -1) {
        content = '';
      } else {
        content = content.slice(nl + 1);
      }
    }
    content = trim(content);
  }
  const out = {};
  const enc = new TextEncoder();
  const keys = [...store.keys()].sort((a, b) => {
    const x = enc.encode(a);
    const y = enc.encode(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  });
  for (const k of keys) out[k] = store.get(k);
  return out;
}

const toTag = (v) => Object.prototype.toString.call(v);
const brand = (fn) => (v) => {
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return false;
  try {
    fn(v);
    return true;
  } catch {
    return false;
  }
};
const MapIteratorProto = Object.getPrototypeOf(new Map()[Symbol.iterator]());
const SetIteratorProto = Object.getPrototypeOf(new Set()[Symbol.iterator]());
const AsyncFunctionProto = Object.getPrototypeOf(async () => {});
const GeneratorFunctionProto = Object.getPrototypeOf(function* () {});
const AsyncGeneratorFunctionProto = Object.getPrototypeOf(async function* () {});
// [[ErrorData]] is what makes Object.prototype.toString say "Error".
const isNativeErrorTag = (v) => toTag(v) === '[object Error]';

/** internalBinding('types'): V8's brand checks, from JS. */
const types = {
  isExternal: () => false,
  isDate: brand((v) => Date.prototype.getTime.call(v)),
  isArgumentsObject: (v) => toTag(v) === '[object Arguments]',
  isBigIntObject: brand((v) => BigInt.prototype.valueOf.call(v)),
  isBooleanObject: brand((v) => Boolean.prototype.valueOf.call(v)),
  isNumberObject: brand((v) => Number.prototype.valueOf.call(v)),
  isStringObject: brand((v) => String.prototype.valueOf.call(v)),
  isSymbolObject: brand((v) => Symbol.prototype.valueOf.call(v)),
  isBoxedPrimitive: (v) =>
    types.isBigIntObject(v) || types.isBooleanObject(v) || types.isNumberObject(v) || types.isStringObject(v) || types.isSymbolObject(v),
  isNativeError: (v) => v !== null && typeof v === 'object' && isNativeErrorTag(v),
  isRegExp: brand((v) => Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get.call(v)),
  isAsyncFunction: (v) =>
    typeof v === 'function' &&
    (Object.getPrototypeOf(v) === AsyncFunctionProto || Object.getPrototypeOf(v) === AsyncGeneratorFunctionProto),
  isGeneratorFunction: (v) =>
    typeof v === 'function' &&
    (Object.getPrototypeOf(v) === GeneratorFunctionProto || Object.getPrototypeOf(v) === AsyncGeneratorFunctionProto),
  isGeneratorObject: (v) => toTag(v) === '[object Generator]' || toTag(v) === '[object AsyncGenerator]',
  isPromise: brand((v) => {
    if (toTag(v) !== '[object Promise]') throw new TypeError();
    Promise.prototype.then.call(v, undefined, undefined);
  }),
  isMap: brand((v) => Map.prototype.has.call(v)),
  isSet: brand((v) => Set.prototype.has.call(v)),
  isMapIterator: (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === MapIteratorProto,
  isSetIterator: (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === SetIteratorProto,
  isWeakMap: brand((v) => WeakMap.prototype.has.call(v, {})),
  isWeakSet: brand((v) => WeakSet.prototype.has.call(v, {})),
  isArrayBuffer: brand((v) => Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get.call(v)),
  isSharedArrayBuffer: (v) =>
    typeof SharedArrayBuffer === 'function' &&
    brand((x) => Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength').get.call(x))(v),
  isAnyArrayBuffer: (v) => types.isArrayBuffer(v) || types.isSharedArrayBuffer(v),
  isDataView: brand((v) => Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength').get.call(v)),
  // Proxies made through the runtime's global Proxy (run.mjs) are known.
  isProxy: (v) => nodeInspect.Proxy.getProxyDetails(v, false) !== undefined,
  isModuleNamespaceObject: (v) =>
    v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === null && v[Symbol.toStringTag] === 'Module',
};

bindings.types = types;
bindings.trace_events = {
  trace() {},
  isTraceCategoryEnabled: () => false,
  getCategoryEnabledBuffer: () => new Uint8Array(1),
};
bindings.config = { hasInspector: false, hasIntl: true };
/** V8's current stack as util.getCallSites gives it, from the caller of util.getCallSites. */
function getCallSites(frameCount) {
  const prevPrepare = Error.prepareStackTrace;
  const prevLimit = Error.stackTraceLimit;
  const holder = {};
  try {
    // The runtime's prepareStackTrace drops its own frames (util.getCallSites
    // among them) before a user formatter sees the rest: capture a few more.
    Error.stackTraceLimit = frameCount + 16;
    Error.prepareStackTrace = (_, callSites) => callSites;
    Error.captureStackTrace(holder, getCallSites);
    const sites = Array.isArray(holder.stack) ? holder.stack : [];
    return sites.slice(0, frameCount).map((site) => ({
      functionName: site.getFunctionName() ?? '',
      scriptId: String(site.getScriptId?.() ?? '0'),
      scriptName: site.getFileName() ?? '',
      lineNumber: site.getLineNumber() ?? 0,
      columnNumber: site.getColumnNumber() ?? 0,
      column: site.getColumnNumber() ?? 0,
    }));
  } finally {
    Error.prepareStackTrace = prevPrepare;
    Error.stackTraceLimit = prevLimit;
  }
}

/** internalBinding('util').getOwnNonIndexProperties (with its filter bits). */
const ONLY_ENUMERABLE = 2;
const SKIP_SYMBOLS = 16;
function getOwnNonIndexProperties(obj, filter) {
  const out = [];
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 2 ** 32 - 1) continue;
    if (typeof key === 'symbol' && filter & SKIP_SYMBOLS) continue;
    if (filter & ONLY_ENUMERABLE && !Object.prototype.propertyIsEnumerable.call(obj, key)) continue;
    out.push(key);
  }
  return out;
}

bindings.buffer = {
  compare(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  },
};

bindings.util = {
  ...bindings.util,
  constants: { ALL_PROPERTIES: 0, ONLY_ENUMERABLE, ONLY_WRITABLE: 1, ONLY_CONFIGURABLE: 4, SKIP_STRINGS: 8, SKIP_SYMBOLS, kPending: 0, kFulfilled: 1, kRejected: 2 },
  getOwnNonIndexProperties,
  getCallSites,
  parseEnv,
  // Map/Set iterator previews (console.table of an iterator): not visible from JS.
  previewEntries: (value, isIterator) => (isIterator ? [[], false] : []),
};

/** libuv's errors (UV_ERRNO_MAP, v1.51.0) with Linux's numbers: util.getSystemErrorMap(). */
export const UV_ERRORS = [
  [-7, 'E2BIG', 'argument list too long'],
  [-13, 'EACCES', 'permission denied'],
  [-98, 'EADDRINUSE', 'address already in use'],
  [-99, 'EADDRNOTAVAIL', 'address not available'],
  [-97, 'EAFNOSUPPORT', 'address family not supported'],
  [-11, 'EAGAIN', 'resource temporarily unavailable'],
  [-3000, 'EAI_ADDRFAMILY', 'address family not supported'],
  [-3001, 'EAI_AGAIN', 'temporary failure'],
  [-3002, 'EAI_BADFLAGS', 'bad ai_flags value'],
  [-3013, 'EAI_BADHINTS', 'invalid value for hints'],
  [-3003, 'EAI_CANCELED', 'request canceled'],
  [-3004, 'EAI_FAIL', 'permanent failure'],
  [-3005, 'EAI_FAMILY', 'ai_family not supported'],
  [-3006, 'EAI_MEMORY', 'out of memory'],
  [-3007, 'EAI_NODATA', 'no address'],
  [-3008, 'EAI_NONAME', 'unknown node or service'],
  [-3009, 'EAI_OVERFLOW', 'argument buffer overflow'],
  [-3014, 'EAI_PROTOCOL', 'resolved protocol is unknown'],
  [-3010, 'EAI_SERVICE', 'service not available for socket type'],
  [-3011, 'EAI_SOCKTYPE', 'socket type not supported'],
  [-114, 'EALREADY', 'connection already in progress'],
  [-9, 'EBADF', 'bad file descriptor'],
  [-16, 'EBUSY', 'resource busy or locked'],
  [-125, 'ECANCELED', 'operation canceled'],
  [-4080, 'ECHARSET', 'invalid Unicode character'],
  [-103, 'ECONNABORTED', 'software caused connection abort'],
  [-111, 'ECONNREFUSED', 'connection refused'],
  [-104, 'ECONNRESET', 'connection reset by peer'],
  [-89, 'EDESTADDRREQ', 'destination address required'],
  [-17, 'EEXIST', 'file already exists'],
  [-14, 'EFAULT', 'bad address in system call argument'],
  [-27, 'EFBIG', 'file too large'],
  [-113, 'EHOSTUNREACH', 'host is unreachable'],
  [-4, 'EINTR', 'interrupted system call'],
  [-22, 'EINVAL', 'invalid argument'],
  [-5, 'EIO', 'i/o error'],
  [-106, 'EISCONN', 'socket is already connected'],
  [-21, 'EISDIR', 'illegal operation on a directory'],
  [-40, 'ELOOP', 'too many symbolic links encountered'],
  [-24, 'EMFILE', 'too many open files'],
  [-90, 'EMSGSIZE', 'message too long'],
  [-36, 'ENAMETOOLONG', 'name too long'],
  [-100, 'ENETDOWN', 'network is down'],
  [-101, 'ENETUNREACH', 'network is unreachable'],
  [-23, 'ENFILE', 'file table overflow'],
  [-105, 'ENOBUFS', 'no buffer space available'],
  [-19, 'ENODEV', 'no such device'],
  [-2, 'ENOENT', 'no such file or directory'],
  [-12, 'ENOMEM', 'not enough memory'],
  [-64, 'ENONET', 'machine is not on the network'],
  [-92, 'ENOPROTOOPT', 'protocol not available'],
  [-28, 'ENOSPC', 'no space left on device'],
  [-38, 'ENOSYS', 'function not implemented'],
  [-107, 'ENOTCONN', 'socket is not connected'],
  [-20, 'ENOTDIR', 'not a directory'],
  [-39, 'ENOTEMPTY', 'directory not empty'],
  [-88, 'ENOTSOCK', 'socket operation on non-socket'],
  [-95, 'ENOTSUP', 'operation not supported on socket'],
  [-75, 'EOVERFLOW', 'value too large for defined data type'],
  [-1, 'EPERM', 'operation not permitted'],
  [-32, 'EPIPE', 'broken pipe'],
  [-71, 'EPROTO', 'protocol error'],
  [-93, 'EPROTONOSUPPORT', 'protocol not supported'],
  [-91, 'EPROTOTYPE', 'protocol wrong type for socket'],
  [-34, 'ERANGE', 'result too large'],
  [-30, 'EROFS', 'read-only file system'],
  [-108, 'ESHUTDOWN', 'cannot send after transport endpoint shutdown'],
  [-29, 'ESPIPE', 'invalid seek'],
  [-3, 'ESRCH', 'no such process'],
  [-110, 'ETIMEDOUT', 'connection timed out'],
  [-26, 'ETXTBSY', 'text file is busy'],
  [-18, 'EXDEV', 'cross-device link not permitted'],
  [-4094, 'UNKNOWN', 'unknown error'],
  [-4095, 'EOF', 'end of file'],
  [-6, 'ENXIO', 'no such device or address'],
  [-31, 'EMLINK', 'too many links'],
  [-112, 'EHOSTDOWN', 'host is down'],
  [-121, 'EREMOTEIO', 'remote I/O error'],
  [-25, 'ENOTTY', 'inappropriate ioctl for device'],
  [-4028, 'EFTYPE', 'inappropriate file type or format'],
  [-84, 'EILSEQ', 'illegal byte sequence'],
  [-94, 'ESOCKTNOSUPPORT', 'socket type not supported'],
  [-61, 'ENODATA', 'no data available'],
  [-49, 'EUNATCH', 'protocol driver not attached'],
  [-8, 'ENOEXEC', 'exec format error'],
];
const uvByErrno = new Map(UV_ERRORS.map(([n, name, msg]) => [n, [name, msg]]));
export const uvErrmapGet = (err) => uvByErrno.get(err);
export const getSystemErrorMap = () => new Map(uvByErrno);
export const getSystemErrorName = (err) => uvByErrno.get(err)?.[0] ?? `Unknown system error ${err}`;
export const getSystemErrorMessage = (err) => uvByErrno.get(err)?.[1] ?? `Unknown system error ${err}`;
