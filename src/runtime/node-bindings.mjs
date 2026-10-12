/**
 * The `internalBinding(name)` that Node's own lib files in src/node-lib see:
 * what Node's C++ gives them, made here over the kernel process (its env,
 * uid/gid) and the platform. Only what those files ask for.
 */
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
