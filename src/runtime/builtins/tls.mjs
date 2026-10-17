/**
 * node:tls — Node 22.22.0's export surface, so a package that requires tls
 * at load (ws, agent-base, …) loads. The pure parts are Node's, ported from
 * lib/tls.js, lib/_tls_common.js, lib/internal/tls/secure-context.js and
 * libuv's inet_pton/inet_ntop (canonicalizeIP): checkServerIdentity,
 * convertALPNProtocols, the DEFAULT_* settings, getCiphers(), the
 * SecureContext option checks. TLSSocket extends net.Socket and Server
 * extends net.Server. There is no TLS on ctx.net, so what needs a handshake
 * (connect, Server#listen, a TLSSocket over a socket, key material) throws
 * ERR_NOT_SUPPORTED when it is called, as https's createServer does.
 */
import {
  ERR_INVALID_ARG_TYPE,
  ERR_INVALID_ARG_VALUE,
  ERR_OUT_OF_RANGE,
  nodeError,
  validateBoolean,
  validateFunction,
  validateInt32,
  validateInteger,
  validateNumber,
  validateObject,
  validateString,
  validateUint32,
} from '../node-errors.mjs';
import { deprecate } from './util.mjs';
import { kConnectTls, kTlsSession } from './net.mjs';
import { kernelAtLeast } from '../kernel-version.mjs';

/** What needs TLS on ctx.net, which the kernel doesn't have (https's message). */
export function noTls(what, why = 'no TLS on ctx.net') {
  const err = new Error(`slicc-jsh: '${what}' is not supported yet (${why})`);
  err.code = 'ERR_NOT_SUPPORTED';
  return err;
}

// Node 22.22.0's (OpenSSL 3.0) default cipher list and getCiphers().
const DEFAULT_CIPHERS =
  'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:' +
  'ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:' +
  'ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:' +
  'DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:' +
  'DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA';

const CIPHERS = [
  'aes128-gcm-sha256', 'aes128-sha', 'aes128-sha256', 'aes256-gcm-sha384', 'aes256-sha',
  'aes256-sha256', 'dhe-psk-aes128-cbc-sha', 'dhe-psk-aes128-cbc-sha256', 'dhe-psk-aes128-gcm-sha256',
  'dhe-psk-aes256-cbc-sha', 'dhe-psk-aes256-cbc-sha384', 'dhe-psk-aes256-gcm-sha384',
  'dhe-psk-chacha20-poly1305', 'dhe-rsa-aes128-gcm-sha256', 'dhe-rsa-aes128-sha', 'dhe-rsa-aes128-sha256',
  'dhe-rsa-aes256-gcm-sha384', 'dhe-rsa-aes256-sha', 'dhe-rsa-aes256-sha256', 'dhe-rsa-chacha20-poly1305',
  'ecdhe-ecdsa-aes128-gcm-sha256', 'ecdhe-ecdsa-aes128-sha', 'ecdhe-ecdsa-aes128-sha256',
  'ecdhe-ecdsa-aes256-gcm-sha384', 'ecdhe-ecdsa-aes256-sha', 'ecdhe-ecdsa-aes256-sha384',
  'ecdhe-ecdsa-chacha20-poly1305', 'ecdhe-psk-aes128-cbc-sha', 'ecdhe-psk-aes128-cbc-sha256',
  'ecdhe-psk-aes256-cbc-sha', 'ecdhe-psk-aes256-cbc-sha384', 'ecdhe-psk-chacha20-poly1305',
  'ecdhe-rsa-aes128-gcm-sha256', 'ecdhe-rsa-aes128-sha', 'ecdhe-rsa-aes128-sha256',
  'ecdhe-rsa-aes256-gcm-sha384', 'ecdhe-rsa-aes256-sha', 'ecdhe-rsa-aes256-sha384',
  'ecdhe-rsa-chacha20-poly1305', 'psk-aes128-cbc-sha', 'psk-aes128-cbc-sha256', 'psk-aes128-gcm-sha256',
  'psk-aes256-cbc-sha', 'psk-aes256-cbc-sha384', 'psk-aes256-gcm-sha384', 'psk-chacha20-poly1305',
  'rsa-psk-aes128-cbc-sha', 'rsa-psk-aes128-cbc-sha256', 'rsa-psk-aes128-gcm-sha256', 'rsa-psk-aes256-cbc-sha',
  'rsa-psk-aes256-cbc-sha384', 'rsa-psk-aes256-gcm-sha384', 'rsa-psk-chacha20-poly1305', 'srp-aes-128-cbc-sha',
  'srp-aes-256-cbc-sha', 'srp-rsa-aes-128-cbc-sha', 'srp-rsa-aes-256-cbc-sha', 'tls_aes_128_ccm_8_sha256',
  'tls_aes_128_ccm_sha256', 'tls_aes_128_gcm_sha256', 'tls_aes_256_gcm_sha384', 'tls_chacha20_poly1305_sha256',
];

const TLS_VERSIONS = { TLSv1: 0x301, 'TLSv1.1': 0x302, 'TLSv1.2': 0x303, 'TLSv1.3': 0x304 };
const SSL_OP_CIPHER_SERVER_PREFERENCE = 0x400000;

// --- internal/net.js: Node's isIP ---------------------------------------
const v4Seg = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])';
const v4Str = `(?:${v4Seg}\\.){3}${v4Seg}`;
const IPv4Reg = new RegExp(`^${v4Str}$`);
const v6Seg = '(?:[0-9a-fA-F]{1,4})';
const IPv6Reg = new RegExp(
  '^(?:' +
    `(?:${v6Seg}:){7}(?:${v6Seg}|:)|` +
    `(?:${v6Seg}:){6}(?:${v4Str}|:${v6Seg}|:)|` +
    `(?:${v6Seg}:){5}(?::${v4Str}|(?::${v6Seg}){1,2}|:)|` +
    `(?:${v6Seg}:){4}(?:(?::${v6Seg}){0,1}:${v4Str}|(?::${v6Seg}){1,3}|:)|` +
    `(?:${v6Seg}:){3}(?:(?::${v6Seg}){0,2}:${v4Str}|(?::${v6Seg}){1,4}|:)|` +
    `(?:${v6Seg}:){2}(?:(?::${v6Seg}){0,3}:${v4Str}|(?::${v6Seg}){1,5}|:)|` +
    `(?:${v6Seg}:){1}(?:(?::${v6Seg}){0,4}:${v4Str}|(?::${v6Seg}){1,6}|:)|` +
    `(?::(?:(?::${v6Seg}){0,5}:${v4Str}|(?::${v6Seg}){1,7}|:))` +
    ')(?:%[0-9a-zA-Z-.:]{1,})?$'
);
export const isIP = (s) => (IPv4Reg.test(s) ? 4 : IPv6Reg.test(s) ? 6 : 0);

// --- libuv's inet_pton / inet_ntop: cares_wrap's canonicalizeIP -----------
function pton4(src, out, at) {
  let sawDigit = false;
  let octets = 0;
  let tp = at;
  out[tp] = 0;
  for (const ch of src) {
    if (ch >= '0' && ch <= '9') {
      const nw = out[tp] * 10 + (ch.charCodeAt(0) - 48);
      if (sawDigit && out[tp] === 0) return false;
      if (nw > 255) return false;
      out[tp] = nw;
      if (!sawDigit) {
        if (++octets > 4) return false;
        sawDigit = true;
      }
    } else if (ch === '.' && sawDigit) {
      if (octets === 4) return false;
      out[++tp] = 0;
      sawDigit = false;
    } else return false;
  }
  return octets >= 4;
}

function pton6(src) {
  const tmp = new Uint8Array(16);
  let tp = 0;
  const endp = 16;
  let colonp = -1;
  let i = 0;
  if (src[0] === ':' && src[++i] !== ':') return null;
  let curtok = i;
  let seen = 0;
  let val = 0;
  while (i < src.length) {
    const ch = src[i++];
    if (/^[0-9a-fA-F]$/.test(ch)) {
      val = (val << 4) | parseInt(ch, 16);
      if (++seen > 4) return null;
      continue;
    }
    if (ch === ':') {
      curtok = i;
      if (!seen) {
        if (colonp !== -1) return null;
        colonp = tp;
        continue;
      } else if (i === src.length) return null;
      if (tp + 2 > endp) return null;
      tmp[tp++] = (val >> 8) & 0xff;
      tmp[tp++] = val & 0xff;
      seen = 0;
      val = 0;
      continue;
    }
    if (ch === '.' && tp + 4 <= endp && pton4(src.slice(curtok), tmp, tp)) {
      tp += 4;
      seen = 0;
      i = src.length;
      break;
    }
    return null;
  }
  if (seen) {
    if (tp + 2 > endp) return null;
    tmp[tp++] = (val >> 8) & 0xff;
    tmp[tp++] = val & 0xff;
  }
  if (colonp !== -1) {
    const n = tp - colonp;
    if (tp === endp) return null;
    for (let k = 1; k <= n; k++) {
      tmp[endp - k] = tmp[colonp + n - k];
      tmp[colonp + n - k] = 0;
    }
    tp = endp;
  }
  return tp === endp ? tmp : null;
}

function ntop6(src) {
  const words = [];
  for (let k = 0; k < 8; k++) words.push((src[2 * k] << 8) | src[2 * k + 1]);
  let best = { base: -1, len: 0 };
  let cur = { base: -1, len: 0 };
  for (let k = 0; k < 8; k++) {
    if (words[k] === 0) {
      if (cur.base === -1) cur = { base: k, len: 1 };
      else cur.len++;
    } else if (cur.base !== -1) {
      if (best.base === -1 || cur.len > best.len) best = cur;
      cur = { base: -1, len: 0 };
    }
  }
  if (cur.base !== -1 && (best.base === -1 || cur.len > best.len)) best = cur;
  if (best.base !== -1 && best.len < 2) best = { base: -1, len: 0 };
  let out = '';
  for (let k = 0; k < 8; k++) {
    if (best.base !== -1 && k >= best.base && k < best.base + best.len) {
      if (k === best.base) out += ':';
      continue;
    }
    if (k !== 0) out += ':';
    if (
      k === 6 &&
      best.base === 0 &&
      (best.len === 6 || (best.len === 7 && words[7] !== 0x0001) || (best.len === 5 && words[5] === 0xffff))
    ) {
      out += `${src[12]}.${src[13]}.${src[14]}.${src[15]}`;
      return out;
    }
    out += words[k].toString(16);
  }
  if (best.base !== -1 && best.base + best.len === 8) out += ':';
  return out;
}

/** cares_wrap's canonicalizeIP: the address as inet_ntop writes it, or undefined. */
function canonicalizeIP(ip) {
  ip = String(ip);
  const v4 = new Uint8Array(4);
  if (pton4(ip, v4, 0)) return v4.join('.');
  const zone = ip.indexOf('%');
  const v6 = pton6(zone === -1 ? ip : ip.slice(0, zone));
  return v6 ? ntop6(v6) : undefined;
}

// --- lib/tls.js: checkServerIdentity ------------------------------------
function unfqdn(host) {
  return host.replace(/[.]$/, '');
}

function splitHost(host) {
  // String#toLowerCase() is locale-sensitive: only A-Z, as Node's.
  return unfqdn(host)
    .replace(/[A-Z]/g, (c) => String.fromCharCode(32 + c.charCodeAt(0)))
    .split('.');
}

function check(hostParts, pattern, wildcards) {
  if (!pattern) return false;
  const patternParts = splitHost(pattern);
  if (hostParts.length !== patternParts.length) return false;
  if (patternParts.includes('')) return false;
  const isBad = (s) => /[^\u0021-\u007F]/u.test(s);
  if (patternParts.some(isBad)) return false;
  for (let i = hostParts.length - 1; i > 0; i -= 1) {
    if (hostParts[i] !== patternParts[i]) return false;
  }
  const hostSubdomain = hostParts[0];
  const patternSubdomain = patternParts[0];
  const patternSubdomainParts = patternSubdomain.split('*', 3);
  if (patternSubdomainParts.length === 1 || patternSubdomain.includes('xn--')) {
    return hostSubdomain === patternSubdomain;
  }
  if (!wildcards) return false;
  if (patternSubdomainParts.length > 2) return false;
  if (patternParts.length <= 2) return false;
  const [prefix, suffix] = patternSubdomainParts;
  if (prefix.length + suffix.length > hostSubdomain.length) return false;
  if (!hostSubdomain.startsWith(prefix)) return false;
  if (!hostSubdomain.endsWith(suffix)) return false;
  return true;
}

// eslint-disable-next-line no-control-regex
const jsonStringPattern = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/;

function splitEscapedAltNames(altNames) {
  const result = [];
  let currentToken = '';
  let offset = 0;
  while (offset !== altNames.length) {
    const nextSep = altNames.indexOf(',', offset);
    const nextQuote = altNames.indexOf('"', offset);
    if (nextQuote !== -1 && (nextSep === -1 || nextQuote < nextSep)) {
      currentToken += altNames.substring(offset, nextQuote);
      const match = jsonStringPattern.exec(altNames.substring(nextQuote));
      if (!match) {
        throw nodeError(SyntaxError, 'ERR_TLS_CERT_ALTNAME_FORMAT', 'Invalid subject alternative name string');
      }
      currentToken += JSON.parse(match[0]);
      offset = nextQuote + match[0].length;
    } else if (nextSep !== -1) {
      currentToken += altNames.substring(offset, nextSep);
      result.push(currentToken);
      currentToken = '';
      offset = nextSep + 2;
    } else {
      currentToken += altNames.substring(offset);
      offset = altNames.length;
    }
  }
  result.push(currentToken);
  return result;
}

function altnameInvalid(reason, host, cert) {
  return Object.assign(
    nodeError(Error, 'ERR_TLS_CERT_ALTNAME_INVALID', `Hostname/IP does not match certificate's altnames: ${reason}`),
    { reason, host, cert }
  );
}

function checkServerIdentity(hostname, cert) {
  const subject = cert.subject;
  const altNames = cert.subjectaltname;
  const dnsNames = [];
  const ips = [];
  hostname = '' + hostname;
  if (altNames) {
    const splitAltNames = altNames.includes('"') ? splitEscapedAltNames(altNames) : altNames.split(', ');
    splitAltNames.forEach((name) => {
      if (name.startsWith('DNS:')) dnsNames.push(name.slice(4));
      else if (name.startsWith('IP Address:')) ips.push(canonicalizeIP(name.slice(11)));
    });
  }
  let valid = false;
  let reason = 'Unknown reason';
  hostname = unfqdn(hostname);
  if (isIP(hostname)) {
    valid = ips.includes(canonicalizeIP(hostname));
    if (!valid) reason = `IP: ${hostname} is not in the cert's list: ` + ips.join(', ');
  } else if (dnsNames.length > 0 || subject?.CN) {
    const hostParts = splitHost(hostname);
    const wildcard = (pattern) => check(hostParts, pattern, true);
    if (dnsNames.length > 0) {
      valid = dnsNames.some(wildcard);
      if (!valid) reason = `Host: ${hostname}. is not in the cert's altnames: ${altNames}`;
    } else {
      const cn = subject.CN;
      if (Array.isArray(cn)) valid = cn.some(wildcard);
      else if (cn) valid = wildcard(cn);
      if (!valid) reason = `Host: ${hostname}. is not cert's CN: ${cn}`;
    }
  } else {
    reason = 'Cert does not contain a DNS name';
  }
  if (!valid) return altnameInvalid(reason, hostname, cert);
  return undefined;
}

export function createTls({ ctx, process, Buffer, net }) {
  // slicc-kernel 1.116.0 (ai-ecoverse/slicc-kernel#923): ctx.net.connect's
  // `tls` carries HTTP/1.1 and WebSocket over TLS through the embedder's
  // transport, which does the handshake and verifies the peer.
  const transportTls = typeof ctx?.net?.connect === 'function' && kernelAtLeast(ctx, '1.116.0');
  const options = () => process?._options ?? process?.execArgv ?? [];
  const hasOption = (flag) => options().includes(flag);
  const optionValue = (name) => {
    const argv = options();
    let value;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === name) value = argv[++i];
      else if (argv[i].startsWith(`${name}=`)) value = argv[i].slice(name.length + 1);
    }
    return value;
  };

  const isArrayBufferView = (v) => ArrayBuffer.isView(v);

  function convertProtocols(protocols) {
    const lens = new Array(protocols.length);
    const buff = Buffer.allocUnsafe(
      protocols.reduce((p, c, i) => {
        const len = Buffer.byteLength(c);
        if (len > 255) {
          throw ERR_OUT_OF_RANGE(
            `The byte length of the protocol at index ${i} exceeds the maximum length.`,
            '<= 255',
            len,
            true
          );
        }
        lens[i] = len;
        return p + 1 + len;
      }, 0)
    );
    let offset = 0;
    for (let i = 0, c = protocols.length; i < c; i++) {
      buff[offset++] = lens[i];
      buff.write(protocols[i], offset);
      offset += lens[i];
    }
    return buff;
  }

  function convertALPNProtocols(protocols, out) {
    if (Array.isArray(protocols)) out.ALPNProtocols = convertProtocols(protocols);
    else if (protocols instanceof Uint8Array) out.ALPNProtocols = Buffer.from(protocols);
    else if (isArrayBufferView(protocols)) {
      out.ALPNProtocols = Buffer.from(
        protocols.buffer.slice(protocols.byteOffset, protocols.byteOffset + protocols.byteLength)
      );
    }
  }

  // --- CA certificates --------------------------------------------------
  // jsh makes no TLS connections itself (https goes through the embedder's
  // fetch, which trusts the platform's store), so it bundles no root store:
  // rootCertificates and the bundled/system/extra lists are empty.
  const EMPTY = Object.freeze([]);
  let userCACertificates;
  function getCACertificates(type = 'default') {
    validateString(type, 'type');
    switch (type) {
      case 'default':
        return userCACertificates ?? EMPTY;
      case 'bundled':
      case 'system':
      case 'extra':
        return EMPTY;
      default:
        throw ERR_INVALID_ARG_VALUE('type', type);
    }
  }
  function setDefaultCACertificates(certs) {
    if (!Array.isArray(certs)) throw ERR_INVALID_ARG_TYPE('certs', 'Array', certs);
    for (let i = 0; i < certs.length; i++) {
      if (typeof certs[i] !== 'string' && !isArrayBufferView(certs[i])) {
        throw ERR_INVALID_ARG_TYPE(`certs[${i}]`, ['string', 'ArrayBufferView'], certs[i]);
      }
    }
    userCACertificates = Object.freeze(
      certs.map((c) => (typeof c === 'string' ? c : Buffer.from(c.buffer, c.byteOffset, c.byteLength).toString()))
    );
  }

  // --- _tls_common.js: SecureContext -------------------------------------
  function toV(which, v, def) {
    v ??= def;
    if (Object.hasOwn(TLS_VERSIONS, v)) return TLS_VERSIONS[v];
    throw nodeError(TypeError, 'ERR_TLS_INVALID_PROTOCOL_VERSION', `${JSON.stringify(v)} is not a valid ${which} TLS protocol version`);
  }

  /** Node's native SecureContext: what was configured, nothing to handshake with. */
  class NativeSecureContext {
    constructor(minProto, maxProto) {
      this.minProto = minProto;
      this.maxProto = maxProto;
    }
  }

  function SecureContext(secureProtocol, secureOptions, minVersion, maxVersion) {
    if (!(this instanceof SecureContext)) {
      return new SecureContext(secureProtocol, secureOptions, minVersion, maxVersion);
    }
    if (secureProtocol) {
      for (const v of [minVersion, maxVersion]) {
        if (v != null) {
          throw nodeError(
            TypeError,
            'ERR_TLS_PROTOCOL_VERSION_CONFLICT',
            `TLS protocol version ${JSON.stringify(v)} conflicts with secureProtocol ${JSON.stringify(secureProtocol)}`
          );
        }
      }
    }
    this.context = new NativeSecureContext(
      toV('minimum', minVersion, exports.DEFAULT_MIN_VERSION),
      toV('maximum', maxVersion, exports.DEFAULT_MAX_VERSION)
    );
    if (secureOptions) validateInteger(secureOptions, 'secureOptions');
  }

  function validateKeyOrCertOption(name, value) {
    if (typeof value !== 'string' && !isArrayBufferView(value)) {
      throw ERR_INVALID_ARG_TYPE(name, ['string', 'Buffer', 'TypedArray', 'DataView'], value);
    }
  }

  /** internal/tls/secure-context.js's checks, in its order; key material is refused. */
  function configSecureContext(context, options = {}, name = 'options') {
    validateObject(options, name);
    const {
      ca,
      cert,
      ciphers = exports.DEFAULT_CIPHERS,
      clientCertEngine,
      crl,
      dhparam,
      ecdhCurve = exports.DEFAULT_ECDH_CURVE || 'auto',
      key,
      pfx,
      privateKeyIdentifier,
      privateKeyEngine,
      sessionIdContext,
      sessionTimeout,
      sigalgs,
      ticketKeys,
    } = options;
    const refuse = (option) => {
      throw noTls(`tls.createSecureContext option '${option}'`);
    };
    if (ciphers !== undefined && ciphers !== null) validateString(ciphers, `${name}.ciphers`);
    const list = String(ciphers || exports.DEFAULT_CIPHERS).split(':');
    if (!list.some((c) => c.length > 0)) throw ERR_INVALID_ARG_VALUE(`${name}.ciphers`, list);
    if (ca) {
      for (const c of Array.isArray(ca) ? ca : [ca]) validateKeyOrCertOption(`${name}.ca`, c);
      refuse('ca');
    }
    if (cert) {
      for (const c of Array.isArray(cert) ? cert : [cert]) validateKeyOrCertOption(`${name}.cert`, c);
      refuse('cert');
    }
    if (key) refuse('key');
    if (sigalgs !== undefined && sigalgs !== null) {
      validateString(sigalgs, `${name}.sigalgs`);
      if (sigalgs === '') throw ERR_INVALID_ARG_VALUE(`${name}.sigalgs`, sigalgs);
    }
    if (privateKeyIdentifier !== undefined && privateKeyIdentifier !== null) {
      if (privateKeyEngine === undefined || privateKeyEngine === null) {
        throw ERR_INVALID_ARG_VALUE(`${name}.privateKeyEngine`, privateKeyEngine);
      }
      refuse('privateKeyIdentifier');
    }
    validateString(ecdhCurve, `${name}.ecdhCurve`);
    if (dhparam !== undefined && dhparam !== null) {
      validateKeyOrCertOption(`${name}.dhparam`, dhparam);
      refuse('dhparam');
    }
    if (crl !== undefined && crl !== null) {
      for (const c of Array.isArray(crl) ? crl : [crl]) validateKeyOrCertOption(`${name}.crl`, c);
      refuse('crl');
    }
    if (sessionIdContext !== undefined && sessionIdContext !== null) {
      validateString(sessionIdContext, `${name}.sessionIdContext`);
    }
    if (pfx !== undefined && pfx !== null) refuse('pfx');
    if (typeof clientCertEngine === 'string') refuse('clientCertEngine');
    else if (clientCertEngine !== undefined && clientCertEngine !== null) {
      throw ERR_INVALID_ARG_TYPE(`${name}.clientCertEngine`, ['string', 'null', 'undefined'], clientCertEngine);
    }
    if (ticketKeys !== undefined && ticketKeys !== null) {
      if (!isArrayBufferView(ticketKeys)) {
        throw ERR_INVALID_ARG_TYPE(`${name}.ticketKeys`, ['Buffer', 'TypedArray', 'DataView'], ticketKeys);
      }
      if (ticketKeys.byteLength !== 48) {
        throw ERR_INVALID_ARG_VALUE(`${name}.ticketKeys`, ticketKeys.byteLength, 'must be exactly 48 bytes');
      }
      context.ticketKeys = Buffer.from(ticketKeys.buffer, ticketKeys.byteOffset, 48);
    }
    if (sessionTimeout !== undefined && sessionTimeout !== null) {
      validateInt32(sessionTimeout, `${name}.sessionTimeout`, 0);
    }
  }

  function createSecureContext(options) {
    options ||= {};
    const { honorCipherOrder, minVersion, maxVersion, secureProtocol } = options;
    let { secureOptions } = options;
    if (honorCipherOrder) secureOptions |= SSL_OP_CIPHER_SERVER_PREFERENCE;
    const c = new SecureContext(secureProtocol, secureOptions, minVersion, maxVersion);
    configSecureContext(c.context, options);
    return c;
  }

  // --- _tls_wrap.js: TLSSocket --------------------------------------------
  class TLSSocket extends net.Socket {
    constructor(socket, opts) {
      const tlsOptions = { ...opts };
      if (tlsOptions.enableTrace != null) validateBoolean(tlsOptions.enableTrace, 'options.enableTrace');
      if (tlsOptions.ALPNProtocols) convertALPNProtocols(tlsOptions.ALPNProtocols, tlsOptions);
      // A TLS session over a socket needs a handshake: there's no TLS on ctx.net.
      if (socket) throw noTls('tls.TLSSocket over a socket');
      super({ allowHalfOpen: tlsOptions.allowHalfOpen });
      this._tlsOptions = tlsOptions;
      this._secureEstablished = false;
      this._securePending = false;
      this._newSessionPending = false;
      this._controlReleased = false;
      this.secureConnecting = true;
      this._SNICallback = null;
      this.servername = null;
      this.alpnProtocol = null;
      this.authorized = false;
      this.authorizationError = null;
      this.encrypted = true;
      this.ssl = null;
    }

    connect() {
      throw noTls('tls.TLSSocket.connect');
    }

    disableRenegotiation() {
      this._disableRenegotiation = true;
    }

    renegotiate(options, callback) {
      validateObject(options, 'options');
      if (callback !== undefined) validateFunction(callback, 'callback');
      if (this.destroyed) return undefined;
      throw noTls('tls.TLSSocket.renegotiate');
    }

    exportKeyingMaterial(length, label, context) {
      validateUint32(length, 'length', true);
      validateString(label, 'label');
      if (context !== undefined && !isArrayBufferView(context)) {
        throw ERR_INVALID_ARG_TYPE('context', ['Buffer', 'TypedArray', 'DataView'], context);
      }
      throw nodeError(Error, 'ERR_TLS_INVALID_STATE', 'TLS socket connection must be securely established');
    }

    setMaxSendFragment(size) {
      validateInt32(size, 'size');
      return false;
    }

    setServername(name) {
      validateString(name, 'name');
      if (this._tlsOptions.isServer) {
        throw nodeError(Error, 'ERR_TLS_SNI_FROM_SERVER', 'Cannot issue SNI from a TLS server-side socket');
      }
    }

    setSession() {}

    setKeyCert() {}

    // Without a session, what Node's TLSSocket answers without a handle. With
    // the kernel's transport session the transport holds the certificates.
    getPeerCertificate() {
      return this._secureEstablished ? {} : null;
    }
    getCertificate() {
      return this._secureEstablished ? {} : null;
    }
    getPeerX509Certificate() {
      return undefined;
    }
    getX509Certificate() {
      return undefined;
    }
  }
  for (const method of [
    'getCipher',
    'getSharedSigalgs',
    'getEphemeralKeyInfo',
    'getFinished',
    'getPeerFinished',
    'getProtocol',
    'getSession',
    'getTLSTicket',
    'isSessionReused',
    'enableTrace',
  ]) {
    Object.defineProperty(TLSSocket.prototype, method, {
      value: { [method]() { return null; } }[method],
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  // --- _tls_wrap.js: Server -----------------------------------------------
  // A function, as Node's: callable without new, and a class can extend it.
  function Server(options, listener) {
    if (!new.target) return new Server(options, listener);
    if (typeof options === 'function') {
      listener = options;
      options = {};
    } else if (options == null || typeof options === 'object') {
      options ??= {};
    } else {
      throw ERR_INVALID_ARG_TYPE('options', 'Object', options);
    }
    const self = Reflect.construct(net.Server, [options], new.target);
    self._contexts = [];
    self.requestCert = options.requestCert === true;
    self.rejectUnauthorized = options.rejectUnauthorized !== false;
    self.ALPNCallback = options.ALPNCallback;
    if (self.ALPNCallback && options.ALPNProtocols) {
      throw nodeError(
        TypeError,
        'ERR_TLS_ALPN_CALLBACK_WITH_PROTOCOLS',
        'The ALPNCallback and ALPNProtocols TLS options are mutually exclusive'
      );
    }
    if (options.sessionTimeout) self.sessionTimeout = options.sessionTimeout;
    if (options.ticketKeys) self.ticketKeys = options.ticketKeys;
    if (options.ALPNProtocols) convertALPNProtocols(options.ALPNProtocols, self);
    self.setSecureContext(options);
    const handshakeTimeout = options.handshakeTimeout || 120 * 1000;
    validateNumber(handshakeTimeout, 'options.handshakeTimeout');
    if (options.SNICallback) validateFunction(options.SNICallback, 'options.SNICallback');
    if (options.pskCallback) validateFunction(options.pskCallback, 'options.pskCallback');
    if (options.pskIdentityHint) validateString(options.pskIdentityHint, 'options.pskIdentityHint');
    if (listener) self.on('secureConnection', listener);
    return self;
  }
  Object.setPrototypeOf(Server.prototype, net.Server.prototype);
  Object.setPrototypeOf(Server, net.Server);
  const serverMethods = {
    setSecureContext(options) {
      validateObject(options, 'options');
      for (const k of ['pfx', 'key', 'passphrase', 'cert', 'clientCertEngine', 'ca', 'minVersion', 'maxVersion',
        'secureProtocol', 'crl', 'sigalgs', 'ciphers', 'ecdhCurve', 'dhparam', 'honorCipherOrder',
        'secureOptions', 'sessionIdContext', 'privateKeyIdentifier', 'privateKeyEngine']) {
        this[k] = options[k] || undefined;
      }
      this._sharedCreds = createSecureContext(options);
    },
    getTicketKeys() {
      return (this._sharedCreds.context.ticketKeys ??= Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(48))));
    },
    setTicketKeys(keys) {
      if (!isArrayBufferView(keys)) throw ERR_INVALID_ARG_TYPE('buffer', ['Buffer', 'TypedArray', 'DataView'], keys);
      if (keys.byteLength !== 48) {
        throw ERR_INVALID_ARG_VALUE('keys', keys.byteLength, 'must be exactly 48 bytes');
      }
      this._sharedCreds.context.ticketKeys = Buffer.from(keys.buffer, keys.byteOffset, 48);
    },
    addContext(servername, context) {
      if (!servername) {
        throw nodeError(Error, 'ERR_TLS_REQUIRED_SERVER_NAME', '"servername" is required parameter for Server.addContext');
      }
      const re = new RegExp(
        `^${servername.replace(/([.^$+?\-\\[\]{}])/g, '\\$1').replace(/\*/g, '[^.]*')}$`
      );
      const secureContext = context instanceof SecureContext ? context : createSecureContext(context);
      this._contexts.push([re, secureContext.context]);
    },
    // Serving TLS needs the handshake: there's no TLS on ctx.net.
    listen() {
      throw noTls('tls.Server.listen');
    },
  };
  for (const [k, v] of Object.entries(serverMethods)) {
    Object.defineProperty(Server.prototype, k, { value: v, writable: true, configurable: true, enumerable: false });
  }

  function createServer(options, listener) {
    return new Server(options, listener);
  }

  // Arguments: [port,] [host,] [options,] [cb]
  /** ALPNProtocols (Node's wire form or a list) as the names for the kernel. */
  function alpnNames(protocols) {
    if (protocols == null) return undefined;
    if (Array.isArray(protocols)) return protocols.map(String);
    const out = {};
    convertALPNProtocols(protocols, out);
    const bytes = out.ALPNProtocols;
    if (!bytes) return undefined;
    const names = [];
    for (let i = 0; i < bytes.length; ) {
      const len = bytes[i];
      names.push(bytes.subarray(i + 1, i + 1 + len).toString('latin1'));
      i += 1 + len;
    }
    return names;
  }

  // Arguments: [port,] [host,] [options,] [cb]
  function connect(...args) {
    let options = {};
    let cb;
    if (typeof args[args.length - 1] === 'function') cb = args.pop();
    if (args[0] !== null && typeof args[0] === 'object') options = { ...args[0] };
    else {
      if (args[0] !== undefined) options.port = args[0];
      if (typeof args[1] === 'string') options.host = args[1];
      const extra = args[1] !== null && typeof args[1] === 'object' ? args[1] : args[2];
      Object.assign(options, extra);
    }
    options = { rejectUnauthorized: true, checkServerIdentity, minDHSize: 1024, ...options };
    validateFunction(options.checkServerIdentity, 'options.checkServerIdentity');
    validateNumber(options.minDHSize, 'options.minDHSize', 1);
    if (!transportTls) throw noTls('tls.connect');
    // TLS over a socket that's already open (STARTTLS, a proxy's tunnel) is
    // a handshake jsh would have to do itself (slicc-kernel#922).
    if (options.socket) throw noTls('tls.connect over a socket');
    if (options.path) throw noTls('tls.connect to a Unix socket');
    // Node makes the context first: its checks (and its refusal of key material) come first.
    if (!options.secureContext) createSecureContext(options);
    const host = options.host ?? 'localhost';
    const port = Number(options.port ?? 443);
    const servername = options.servername || (isIP(host) ? undefined : host);
    const socket = new TLSSocket(undefined, { ALPNProtocols: options.ALPNProtocols, allowHalfOpen: options.allowHalfOpen });
    socket._tlsOptions.isServer = false;
    if (cb) socket.once('secureConnect', cb);
    socket.once('connect', () => {
      const session = socket[kTlsSession];
      socket._secureEstablished = true;
      socket.secureConnecting = false;
      socket.authorized = session.authorized === true;
      socket.authorizationError = socket.authorized ? null : 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
      socket.alpnProtocol = session.alpnProtocol || false;
      socket.servername = session.servername || servername || false;
      process.nextTick(() => {
        if (!socket.destroyed) socket.emit('secureConnect');
      });
    });
    const refused = (err) => {
      const code = err?.code ?? err?.cause?.code;
      if (code === 'EPROTONOSUPPORT') {
        return noTls(`tls.connect to ${host}:${port}`, "the kernel's TLS carries HTTP/1.1 and WebSocket only");
      }
      if (code === 'ENOTSUP') {
        return noTls(`tls.connect to ${host}:${port}`, "the kernel's TLS goes through its transport, which has no loopback");
      }
      return undefined;
    };
    Reflect.apply(net.Socket.prototype.connect, socket, [
      {
        host,
        port,
        signal: options.signal,
        [kConnectTls]: {
          tls: {
            ...(servername ? { servername } : {}),
            ...(alpnNames(options.ALPNProtocols) ? { alpn: alpnNames(options.ALPNProtocols) } : {}),
            rejectUnauthorized: options.rejectUnauthorized !== false,
          },
          refused,
        },
      },
    ]);
    return socket;
  }


  const exports = {
    CLIENT_RENEG_LIMIT: 3,
    CLIENT_RENEG_WINDOW: 600,
    DEFAULT_CIPHERS: optionValue('--tls-cipher-list') ?? DEFAULT_CIPHERS,
    DEFAULT_ECDH_CURVE: 'auto',
    DEFAULT_MIN_VERSION: hasOption('--tls-min-v1.0')
      ? 'TLSv1'
      : hasOption('--tls-min-v1.1')
        ? 'TLSv1.1'
        : !hasOption('--tls-min-v1.2') && hasOption('--tls-min-v1.3')
          ? 'TLSv1.3'
          : 'TLSv1.2',
    DEFAULT_MAX_VERSION: hasOption('--tls-max-v1.3') ? 'TLSv1.3' : hasOption('--tls-max-v1.2') ? 'TLSv1.2' : 'TLSv1.3',
    // Node's is internalUtil.cachedResult's: a fresh copy, an anonymous function.
    getCiphers: [() => CIPHERS.slice()][0],
  };
  Object.defineProperty(exports, 'rootCertificates', {
    configurable: false,
    enumerable: true,
    get: function cacheBundledRootCertificates() {
      return EMPTY;
    },
  });
  Object.assign(exports, {
    getCACertificates,
    setDefaultCACertificates,
    convertALPNProtocols,
    checkServerIdentity,
    createSecureContext,
    SecureContext,
    TLSSocket,
    Server,
    createServer,
    connect,
    createSecurePair: deprecate(
      function createSecurePair() {
        throw noTls('tls.createSecurePair');
      },
      'tls.createSecurePair() is deprecated. Please use tls.TLSSocket instead.',
      'DEP0064'
    ),
  });
  return exports;
}
