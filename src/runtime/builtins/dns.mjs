/**
 * node:dns and node:dns/promises — Node 22.22.0's surface (lib/dns.js,
 * lib/internal/dns/{utils,callback_resolver,promises}.js), so a package
 * that requires dns at load (pg, mongodb, ioredis, redis, undici, got,
 * nodemailer, fastify, …) loads, and dns.lookup answers.
 *
 * lookup is getaddrinfo through the kernel's resolver, `ctx.net.resolve`
 * (slicc-kernel 1.113.0, ai-ecoverse/slicc-kernel#913): its hosts file
 * (/etc/hosts), its own names, then the uplink. On an older kernel jsh
 * answers IP literals, `localhost` and `*.localhost`, the kernel's own
 * hostname and `host.slicc.internal` as the kernel's hosts file does, and
 * any other name is Node's `getaddrinfo ENOTFOUND <name>`, as in a Node with
 * no resolver. resolve4/resolve6 use `ctx.net.resolve` too;
 * the other record types need a DNS transport jsh doesn't have, so they fail
 * as c-ares does with no nameserver that answers (`queryMx ECONNREFUSED`).
 */
import {
  ERR_INVALID_ARG_TYPE,
  ERR_INVALID_ARG_VALUE,
  ERR_MISSING_ARGS,
  determineSpecificType,
  nodeError,
  validateArray,
  validateBoolean,
  validateFunction,
  validateInt32,
  validateNumber,
  validateOneOf,
  validateString,
  validateUint32,
} from '../node-errors.mjs';
import { trackPromise } from '../async-handles.mjs';
import { isIP } from './tls.mjs';
import { kCustomPromisifyArgs } from './util.mjs';

// getaddrinfo flags, as Linux's (jsh's os is the kernel's: Linux constants).
const AI_V4MAPPED = 0x0008;
const AI_ALL = 0x0010;
const AI_ADDRCONFIG = 0x0020;

const UV_EAI_AGAIN = -3001;
const UV_EAI_NONAME = -3008;
const UV_EINVAL = -22;

const errorCodes = {
  NODATA: 'ENODATA',
  FORMERR: 'EFORMERR',
  SERVFAIL: 'ESERVFAIL',
  NOTFOUND: 'ENOTFOUND',
  NOTIMP: 'ENOTIMP',
  REFUSED: 'EREFUSED',
  BADQUERY: 'EBADQUERY',
  BADNAME: 'EBADNAME',
  BADFAMILY: 'EBADFAMILY',
  BADRESP: 'EBADRESP',
  CONNREFUSED: 'ECONNREFUSED',
  TIMEOUT: 'ETIMEOUT',
  EOF: 'EOF',
  FILE: 'EFILE',
  NOMEM: 'ENOMEM',
  DESTRUCTION: 'EDESTRUCTION',
  BADSTR: 'EBADSTR',
  BADFLAGS: 'EBADFLAGS',
  NONAME: 'ENONAME',
  BADHINTS: 'EBADHINTS',
  NOTINITIALIZED: 'ENOTINITIALIZED',
  LOADIPHLPAPI: 'ELOADIPHLPAPI',
  ADDRGETNETWORKPARAMS: 'EADDRGETNETWORKPARAMS',
  CANCELLED: 'ECANCELLED',
};

const validDnsOrders = ['verbatim', 'ipv4first', 'ipv6first'];
const validFamilies = [0, 4, 6];
const IANA_DNS_PORT = 53;
const IPv6RE = /^\[([^[\]]*)\]/;
const addrSplitRE = /(^.+?)(?::(\d+))?$/;

// The kernel's hosts file (slicc-kernel loopback-names.ts): its own names.
const HOSTNAME_ADDRESS = '127.0.1.1';
const LIBC_HOSTNAMES = ['emscripten', 'wasmer.sh'];
const LOOPBACK_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost']);
const HOST_LOOPBACK = 'host.slicc.internal';
const HOST_LOOPBACK_ADDRESS = '10.0.2.2';

// /etc/services' names for the common TCP ports (what getnameinfo answers).
const SERVICES = {
  21: 'ftp',
  22: 'ssh',
  23: 'telnet',
  25: 'smtp',
  53: 'domain',
  80: 'http',
  110: 'pop3',
  443: 'https',
  993: 'imaps',
  995: 'pop3s',
};

/** internal/errors DNSException. */
function dnsException(code, syscall, hostname) {
  let errno;
  if (typeof code === 'number') {
    errno = code;
    code = { [UV_EAI_NONAME]: 'ENOTFOUND', [UV_EAI_AGAIN]: 'EAI_AGAIN', [UV_EINVAL]: 'EINVAL' }[code] ?? 'EIO';
  }
  const err = new Error(`${syscall} ${code}${hostname ? ` ${hostname}` : ''}`);
  err.errno = errno;
  err.code = code;
  err.syscall = syscall;
  if (hostname) err.hostname = hostname;
  return err;
}

function validatePort(port, name = 'Port', allowZero = true) {
  if (
    (typeof port !== 'number' && typeof port !== 'string') ||
    (typeof port === 'string' && port.trim().length === 0) ||
    +port !== +port >>> 0 ||
    port > 0xffff ||
    (port === 0 && !allowZero)
  ) {
    throw nodeError(
      RangeError,
      'ERR_SOCKET_BAD_PORT',
      `${name} should be ${allowZero ? '>=' : '>'} 0 and < 65536. Received ${determineSpecificType(port)}.`
    );
  }
  return port | 0;
}

export function createDns({ ctx, process, handles, hostname = 'slicc' }) {
  const own = [...new Set([String(hostname).toLowerCase(), ...LIBC_HOSTNAMES])];
  const optionValue = (name) => {
    const argv = process?._options ?? process?.execArgv ?? [];
    let value;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === name) value = argv[++i];
      else if (argv[i].startsWith(`${name}=`)) value = argv[i].slice(name.length + 1);
    }
    return value;
  };
  let dnsOrder;
  const fromCli = optionValue('--dns-result-order');
  if (fromCli) {
    validateOneOf(fromCli, '--dns-result-order', validDnsOrders);
    dnsOrder = fromCli;
  } else dnsOrder = 'verbatim';

  const getDefaultResultOrder = () => dnsOrder;
  function setDefaultResultOrder(value) {
    validateOneOf(value, 'dnsOrder', validDnsOrders);
    dnsOrder = value;
  }

  const resolver = typeof ctx?.net?.resolve === 'function' ? ctx.net.resolve.bind(ctx.net) : null;

  /** The kernel's hosts file: addresses for a name of its own, else undefined. */
  function hostsEntry(name, family) {
    const key = name.toLowerCase().replace(/\.$/, '');
    let v4;
    let v6;
    if (own.includes(key)) v4 = HOSTNAME_ADDRESS;
    else if (LOOPBACK_NAMES.has(key) || key.endsWith('.localhost')) {
      v4 = '127.0.0.1';
      v6 = '::1';
    } else if (key === HOST_LOOPBACK) v4 = HOST_LOOPBACK_ADDRESS;
    else return undefined;
    if (family === 4) return [v4];
    if (family === 6) return v6 ? [v6] : [];
    return v6 ? [v4, v6] : [v4];
  }

  let warnedInvalidHostname = false;
  function emitInvalidHostnameWarning(name) {
    if (warnedInvalidHostname) return;
    warnedInvalidHostname = true;
    process?.emitWarning?.(
      `The provided hostname "${name}" is not a valid hostname, and is supported in the dns module solely for compatibility.`,
      'DeprecationWarning',
      'DEP0118'
    );
  }

  function validateHints(hints) {
    if ((hints & ~(AI_ADDRCONFIG | AI_ALL | AI_V4MAPPED)) !== 0) throw ERR_INVALID_ARG_VALUE('hints', hints);
  }

  /** getaddrinfo: the kernel's names, then its resolver if ctx has one. Rejects with a uv errno. */
  async function getaddrinfo(name, family, order) {
    let addresses;
    // The kernel's resolver answers its hosts file (/etc/hosts too), its own
    // names and the uplink; without one, jsh answers the kernel's own names.
    if (!resolver) addresses = hostsEntry(name, family);
    else {
      try {
        addresses = await resolver(name, { family });
      } catch (err) {
        const code = err?.code ?? err?.cause?.code;
        throw code === 'EAI_AGAIN' ? UV_EAI_AGAIN : UV_EAI_NONAME;
      }
    }
    if (!addresses?.length) throw UV_EAI_NONAME;
    addresses = [...addresses];
    if (order === 'ipv4first') addresses.sort((a, b) => isIP(a) - isIP(b));
    else if (order === 'ipv6first') addresses.sort((a, b) => isIP(b) - isIP(a));
    return addresses;
  }

  /** Runs `work` (a promise) keeping the loop alive; `done` on a later tick, outside the promise. */
  function settle(work, done) {
    const p = work.then(
      (value) => process.nextTick(done, null, value),
      (err) => process.nextTick(done, err)
    );
    if (handles) void trackPromise(handles, p);
    return p;
  }

  function parseLookupOptions(options, callbackForm, args) {
    let hints = 0;
    let family = 0;
    let all = false;
    let order = dnsOrder;
    if (callbackForm && typeof options === 'function') return { hints, family, all, order, callback: options };
    let callback = args?.callback;
    if (typeof options === 'number') {
      if (callbackForm) validateFunction(callback, 'callback');
      validateOneOf(options, 'family', validFamilies);
      family = options;
    } else if (options !== undefined && typeof options !== 'object') {
      if (callbackForm) validateFunction(args.argc === 2 ? options : callback, 'callback');
      throw ERR_INVALID_ARG_TYPE('options', ['integer', 'object'], options);
    } else {
      if (callbackForm) validateFunction(callback, 'callback');
      if (options?.hints != null) {
        validateNumber(options.hints, 'options.hints');
        hints = options.hints >>> 0;
        validateHints(hints);
      }
      if (options?.family != null) {
        if (callbackForm && options.family === 'IPv4') family = 4;
        else if (callbackForm && options.family === 'IPv6') family = 6;
        else {
          validateOneOf(options.family, 'options.family', validFamilies);
          family = options.family;
        }
      }
      if (options?.all != null) {
        validateBoolean(options.all, 'options.all');
        all = options.all;
      }
      if (options?.verbatim != null) {
        validateBoolean(options.verbatim, 'options.verbatim');
        order = options.verbatim ? 'verbatim' : 'ipv4first';
      }
      if (options?.order != null) {
        validateOneOf(options.order, 'options.order', validDnsOrders);
        order = options.order;
      }
    }
    return { hints, family, all, order, callback };
  }

  const toEntries = (addresses, family) => addresses.map((address) => ({ address, family: family || isIP(address) }));

  function lookup(hostname, options, callback) {
    if (hostname) validateString(hostname, 'hostname');
    const o = parseLookupOptions(options, true, { callback, argc: arguments.length });
    callback = o.callback;
    const { family, all } = o;
    if (!hostname) {
      emitInvalidHostnameWarning(hostname);
      if (all) process.nextTick(callback, null, []);
      else process.nextTick(callback, null, null, family === 6 ? 6 : 4);
      return {};
    }
    const matched = isIP(hostname);
    if (matched) {
      if (all) process.nextTick(callback, null, [{ address: hostname, family: matched }]);
      else process.nextTick(callback, null, hostname, matched);
      return {};
    }
    const req = {};
    settle(getaddrinfo(hostname, family, o.order), (err, addresses) => {
      if (err != null) return callback(dnsException(err, 'getaddrinfo', hostname));
      if (all) return callback(null, toEntries(addresses, family));
      return callback(null, addresses[0], family || isIP(addresses[0]));
    });
    return req;
  }
  Object.defineProperty(lookup, kCustomPromisifyArgs, {
    value: ['address', 'family'],
    enumerable: false,
  });

  /** getnameinfo: the kernel's names for its own addresses, else the address; /etc/services' names. */
  function nameinfo(address, port) {
    let host = address;
    if (/^127\./.test(address) && address !== HOSTNAME_ADDRESS) host = 'localhost';
    else if (address === '::1') host = 'localhost';
    else if (address === HOSTNAME_ADDRESS) host = own[0];
    else if (address === HOST_LOOPBACK_ADDRESS) host = HOST_LOOPBACK;
    return { hostname: host, service: SERVICES[port] ?? String(port) };
  }

  function lookupService(address, port, callback) {
    if (arguments.length !== 3) throw ERR_MISSING_ARGS('address', 'port', 'callback');
    if (isIP(address) === 0) throw ERR_INVALID_ARG_VALUE('address', address);
    validatePort(port);
    validateFunction(callback, 'callback');
    const { hostname: host, service } = nameinfo(address, +port);
    process.nextTick(callback, null, host, service);
    return {};
  }
  Object.defineProperty(lookupService, kCustomPromisifyArgs, {
    value: ['hostname', 'service'],
    enumerable: false,
  });

  // --- internal/dns/utils.js ResolverBase ---------------------------------
  const kServers = Symbol('servers');
  const kPending = Symbol('pending');

  /** A c-ares query: A and AAAA through the kernel's resolver if ctx has one; else no nameserver answers. */
  async function query(bindingName, name, signal) {
    if (bindingName === 'getHostByAddr') {
      const names = { '::1': ['localhost'], [HOST_LOOPBACK_ADDRESS]: [HOST_LOOPBACK], [HOSTNAME_ADDRESS]: [own[0]] };
      if (/^127\./.test(name) && name !== HOSTNAME_ADDRESS) return ['localhost'];
      if (names[name]) return names[name];
      throw 'ECONNREFUSED';
    }
    const family = bindingName === 'queryA' ? 4 : bindingName === 'queryAaaa' ? 6 : 0;
    if (!family || !resolver) throw 'ECONNREFUSED';
    let addresses;
    try {
      addresses = await resolver(name, { family, signal });
    } catch (err) {
      if (signal?.aborted) throw 'ECANCELLED';
      throw (err?.code ?? err?.cause?.code) === 'EAI_AGAIN' ? 'ETIMEOUT' : 'ENOTFOUND';
    }
    if (signal?.aborted) throw 'ECANCELLED';
    if (!addresses?.length) throw 'ENOTFOUND';
    return addresses;
  }

  class ResolverBase {
    constructor(options = undefined) {
      const { timeout = -1, tries = 4, maxTimeout = 0 } = { ...options };
      validateInt32(timeout, 'options.timeout', -1);
      validateInt32(tries, 'options.tries', 1);
      validateUint32(maxTimeout, 'options.maxTimeout');
      this._handle = null;
      this[kServers] = [];
      this[kPending] = new Set();
    }
    cancel() {
      for (const abort of this[kPending]) abort.abort();
      this[kPending].clear();
    }
    getServers() {
      return this[kServers].map(([family, host, port]) => {
        if (!port || port === IANA_DNS_PORT) return host;
        return `${family === 6 ? `[${host}]` : host}:${port}`;
      });
    }
    setServers(servers) {
      validateArray(servers, 'servers');
      const newSet = [];
      servers.forEach((serv, index) => {
        validateString(serv, `servers[${index}]`);
        let ipVersion = isIP(serv);
        if (ipVersion !== 0) return newSet.push([ipVersion, serv, IANA_DNS_PORT]);
        const match = IPv6RE.exec(serv);
        if (match) {
          ipVersion = isIP(match[1]);
          if (ipVersion !== 0) {
            const port = Number.parseInt(serv.replace(addrSplitRE, '$2')) || IANA_DNS_PORT;
            return newSet.push([ipVersion, match[1], port]);
          }
        }
        const split = addrSplitRE.exec(serv);
        if (split) {
          const hostIP = split[1];
          const port = split[2] || IANA_DNS_PORT;
          ipVersion = isIP(hostIP);
          if (ipVersion !== 0) return newSet.push([ipVersion, hostIP, Number.parseInt(port)]);
        }
        throw nodeError(TypeError, 'ERR_INVALID_IP_ADDRESS', `Invalid IP address: ${serv}`);
      });
      this[kServers] = newSet;
    }
    setLocalAddress(ipv4, ipv6) {
      validateString(ipv4, 'ipv4');
      if (ipv6 !== undefined) validateString(ipv6, 'ipv6');
      if (!isIP(ipv4) || (ipv6 !== undefined && isIP(ipv6) !== 6)) {
        throw nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', 'Invalid IP address.');
      }
    }
  }

  function runQuery(resolverObj, bindingName, name, ttl) {
    const abort = new AbortController();
    resolverObj[kPending].add(abort);
    return query(bindingName, name, abort.signal)
      .then((result) => (ttl ? result.map((address) => ({ address, ttl: 0 })) : result))
      .finally(() => resolverObj[kPending].delete(abort));
  }

  function createResolverClass(makeQuery) {
    const resolveMap = { __proto__: null };
    class Resolver extends ResolverBase {}
    Resolver.prototype.resolveAny = resolveMap.ANY = makeQuery('queryAny');
    Resolver.prototype.resolve4 = resolveMap.A = makeQuery('queryA');
    Resolver.prototype.resolve6 = resolveMap.AAAA = makeQuery('queryAaaa');
    Resolver.prototype.resolveCaa = resolveMap.CAA = makeQuery('queryCaa');
    Resolver.prototype.resolveCname = resolveMap.CNAME = makeQuery('queryCname');
    Resolver.prototype.resolveMx = resolveMap.MX = makeQuery('queryMx');
    Resolver.prototype.resolveNs = resolveMap.NS = makeQuery('queryNs');
    Resolver.prototype.resolveTlsa = resolveMap.TLSA = makeQuery('queryTlsa');
    Resolver.prototype.resolveTxt = resolveMap.TXT = makeQuery('queryTxt');
    Resolver.prototype.resolveSrv = resolveMap.SRV = makeQuery('querySrv');
    Resolver.prototype.resolvePtr = resolveMap.PTR = makeQuery('queryPtr');
    Resolver.prototype.resolveNaptr = resolveMap.NAPTR = makeQuery('queryNaptr');
    Resolver.prototype.resolveSoa = resolveMap.SOA = makeQuery('querySoa');
    Resolver.prototype.reverse = makeQuery('getHostByAddr');
    return { Resolver, resolveMap };
  }

  const resolverKeys = [
    'getServers', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx',
    'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse',
  ];
  let defaultResolver;
  const getDefaultResolver = () => (defaultResolver ??= new ResolverBase());
  function bindDefaultResolver(target, source) {
    const r = getDefaultResolver();
    for (const key of resolverKeys) target[key] = source[key].bind(r);
  }

  // A query on getHostByAddr checks its address as c-ares does, synchronously.
  const checkReverse = (bindingName, name) => {
    if (bindingName === 'getHostByAddr' && !isIP(name)) throw dnsException(UV_EINVAL, bindingName, name);
  };

  // --- internal/dns/callback_resolver.js ----------------------------------
  const callbackApi = createResolverClass((bindingName) => {
    function q(name, callback) {
      let options;
      if (arguments.length > 2) {
        options = callback;
        callback = arguments[2];
      }
      validateString(name, 'name');
      validateFunction(callback, 'callback');
      checkReverse(bindingName, name);
      settle(runQuery(this, bindingName, name, !!options?.ttl), (err, result) => {
        if (err != null) return callback(dnsException(err, bindingName, name));
        return callback(null, result);
      });
      return {};
    }
    Object.defineProperty(q, 'name', { value: bindingName });
    return q;
  });
  callbackApi.Resolver.prototype.resolve = function resolve(hostname, rrtype, callback) {
    let fn;
    if (typeof rrtype === 'string') fn = callbackApi.resolveMap[rrtype];
    else if (typeof rrtype === 'function') {
      fn = callbackApi.resolveMap.A;
      callback = rrtype;
    } else throw ERR_INVALID_ARG_TYPE('rrtype', 'string', rrtype);
    if (typeof fn === 'function') return Reflect.apply(fn, this, [hostname, callback]);
    throw ERR_INVALID_ARG_VALUE('rrtype', rrtype);
  };
  // The bundler may rename a function expression; Node's is named resolve.
  Object.defineProperty(callbackApi.Resolver.prototype.resolve, 'name', { value: 'resolve' });

  // --- internal/dns/promises.js -------------------------------------------
  const promiseApi = createResolverClass((bindingName) => {
    function q(name, options) {
      validateString(name, 'name');
      return new Promise((resolve, reject) => {
        checkReverse(bindingName, name);
        settle(runQuery(this, bindingName, name, !!options?.ttl), (err, result) => {
          if (err != null) reject(dnsException(err, bindingName, name));
          else resolve(result);
        });
      });
    }
    Object.defineProperty(q, 'name', { value: bindingName });
    return q;
  });
  promiseApi.Resolver.prototype.resolve = function resolve(hostname, rrtype) {
    let fn;
    if (rrtype !== undefined) {
      validateString(rrtype, 'rrtype');
      fn = promiseApi.resolveMap[rrtype];
      if (typeof fn !== 'function') throw ERR_INVALID_ARG_VALUE('rrtype', rrtype);
    } else fn = promiseApi.resolveMap.A;
    return Reflect.apply(fn, this, [hostname]);
  };
  Object.defineProperty(promiseApi.Resolver.prototype.resolve, 'name', { value: 'resolve' });

  function promisesLookup(hostname, options) {
    if (hostname) validateString(hostname, 'hostname');
    const { family, all, order } = parseLookupOptions(options, false);
    return new Promise((resolve, reject) => {
      if (!hostname) {
        emitInvalidHostnameWarning(hostname);
        resolve(all ? [] : { address: null, family: family === 6 ? 6 : 4 });
        return;
      }
      const matched = isIP(hostname);
      if (matched !== 0) {
        const result = { address: hostname, family: matched };
        resolve(all ? [result] : result);
        return;
      }
      settle(getaddrinfo(hostname, family, order), (err, addresses) => {
        if (err != null) return reject(dnsException(err, 'getaddrinfo', hostname));
        if (all) return resolve(toEntries(addresses, family));
        return resolve({ address: addresses[0], family: family || isIP(addresses[0]) });
      });
    });
  }

  function promisesLookupService(address, port) {
    if (arguments.length !== 2) throw ERR_MISSING_ARGS('address', 'port');
    if (isIP(address) === 0) throw ERR_INVALID_ARG_VALUE('address', address);
    validatePort(port);
    return Promise.resolve(nameinfo(address, +port));
  }

  const errorExports = { ...errorCodes };
  const promises = {
    lookup: Object.defineProperty(promisesLookup, 'name', { value: 'lookup' }),
    lookupService: Object.defineProperty(promisesLookupService, 'name', { value: 'lookupService' }),
    Resolver: promiseApi.Resolver,
    getDefaultResultOrder,
    setDefaultResultOrder,
    setServers: function defaultResolverSetServers(servers) {
      const r = new promiseApi.Resolver();
      r.setServers(servers);
      defaultResolver = r;
      bindDefaultResolver(dns, callbackApi.Resolver.prototype);
      bindDefaultResolver(promises, promiseApi.Resolver.prototype);
    },
    ...errorExports,
  };
  bindDefaultResolver(promises, promiseApi.Resolver.prototype);

  const dns = {
    lookup,
    lookupService,
    Resolver: callbackApi.Resolver,
    getDefaultResultOrder,
    setDefaultResultOrder,
    setServers: function defaultResolverSetServers(servers) {
      const r = new callbackApi.Resolver();
      r.setServers(servers);
      defaultResolver = r;
      bindDefaultResolver(dns, callbackApi.Resolver.prototype);
      bindDefaultResolver(promises, promiseApi.Resolver.prototype);
    },
    ADDRCONFIG: AI_ADDRCONFIG,
    ALL: AI_ALL,
    V4MAPPED: AI_V4MAPPED,
    ...errorExports,
  };
  bindDefaultResolver(dns, callbackApi.Resolver.prototype);
  Object.defineProperty(dns, 'promises', { configurable: true, enumerable: true, get: () => promises });
  return { dns, promises };
}
