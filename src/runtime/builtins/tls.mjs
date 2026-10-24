/**
 * node:tls — Node 22.22.0's export surface, so a package that requires tls
 * at load (ws, agent-base, …) loads. The pure parts are Node's, ported from
 * lib/tls.js, lib/_tls_common.js, lib/internal/tls/secure-context.js and
 * libuv's inet_pton/inet_ntop (canonicalizeIP): checkServerIdentity,
 * convertALPNProtocols, the DEFAULT_* settings, getCiphers(), the
 * SecureContext option checks. TLSSocket extends net.Socket and Server
 * extends net.Server. Handshakes are the kernel's: a client's on ctx.net.connect,
 * a server's on ctx.net.secure (slicc-kernel 1.149.0), with the program's own
 * certificate and key.
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
import { kConnectTls, kDetach, kDropHandshake, kIoError, kIpc, kServesTls, kStartNow, kStartTls, kTlsSession } from './net.mjs';
import { certificateObject, isIssuedBy, likelyIssued, parseCertificate } from './x509.mjs';
import { lockedKeyError } from './tls-key.mjs';
import { ERRNO } from '../node-bindings.mjs';

// tls.connect's options on its socket (Node's kConnectOptions).
const kConnectOptions = Symbol('slicc-jsh.tls.connectOptions');
// A SecureContext's `ca`, as given (slicc-kernel 1.124.0 takes it).
const kCa = Symbol('slicc-jsh.tls.ca');
// A socket's parsed peer chain, and the ca it was given (for Node's issuer chain).
const kPeerChain = Symbol('slicc-jsh.tls.peerChain');
const kStore = Symbol('slicc-jsh.tls.store');
// The verdict onConnectSecure destroys with, after 'secure' (as Node's does).
const kVerifyError = Symbol('slicc-jsh.tls.verifyError');
// What a checkServerIdentity threw: onConnectSecure throws it on, as Node's does.
const kThrown = Symbol('slicc-jsh.tls.thrown');
// A SecureContext's client certificate and key (slicc-kernel 1.124.13), and
// the certificate parsed, on the context and on a socket that has it.
const kOwnCert = Symbol('slicc-jsh.tls.ownCert');
const kOwnKey = Symbol('slicc-jsh.tls.ownKey');
const kLeafRefusal = Symbol('slicc-jsh.tls.leafRefusal');
const kOwnLeaf = Symbol('slicc-jsh.tls.ownLeaf');
const kErrorEmitted = Symbol('slicc-jsh.tls.errorEmitted');
const kHandshakeTimeout = Symbol('slicc-jsh.tls.handshakeTimeout');
const kSNICallback = Symbol('slicc-jsh.tls.SNICallback');
const kALPNCallback = Symbol('slicc-jsh.tls.ALPNCallback');
const kHeld = Symbol('slicc-jsh.tls.held');
const kRefusal = Symbol('slicc-jsh.tls.refusal');

// OpenSSL 3.0's errors for key material, as Node 22.22.0 throws them.
const OSSL_ERRORS = {
  ERR_OSSL_BAD_DECRYPT: [
    'Provider routines',
    'bad decrypt',
    'error:1C800064',
    [
      'error:11800074:PKCS12 routines::pkcs12 cipherfinal error',
      'error:1C800064:Provider routines::bad decrypt',
      'error:11800074:PKCS12 routines::pkcs12 cipherfinal error',
    ],
  ],
  ERR_OSSL_UNSUPPORTED: ['DECODER routines', 'unsupported', 'error:1E08010C'],
  ERR_OSSL_EVP_UNSUPPORTED_KEYLENGTH: [
    'digital envelope routines',
    'unsupported keylength',
    'error:0300007B',
    ['error:0300007B:digital envelope routines::unsupported keylength'],
  ],
  ERR_OSSL_CRYPTO_PARAM_UNSIGNED_INTEGER_NEGATIVE_VALUE_UNSUPPORTED: [
    'common libcrypto routines',
    'param unsigned integer negative value unsupported',
    'error:0780007D',
    ['error:0780007D:common libcrypto routines::param unsigned integer negative value unsupported'],
  ],
  ERR_OSSL_INVALID_ITERATION_COUNT: [
    'Provider routines',
    'invalid iteration count',
    'error:1C80007B',
    ['error:1C80007B:Provider routines::invalid iteration count'],
  ],
  ERR_OSSL_X509_KEY_VALUES_MISMATCH: ['x509 certificate routines', 'key values mismatch', 'error:05800074'],
  ERR_OSSL_PEM_NO_START_LINE: ['PEM routines', 'no start line', 'error:0480006C'],
  ERR_OSSL_PEM_BAD_END_LINE: ['PEM routines', 'bad end line', 'error:04800066'],
};

function osslError(code, stack = OSSL_ERRORS[code][3]) {
  const [library, reason, id] = OSSL_ERRORS[code];
  const err = new Error(`${id}:${library}::${reason}`);
  if (stack?.length) err.opensslErrorStack = [...stack];
  return Object.assign(err, { library, reason, code });
}

// OpenSSL 3.0's reason for each TLS alert a peer sends (SSL_R_*: 1000 plus
// the alert's number), as Node 22.22.0's OpenSSL words them.
const ALERT_REASONS = {
  10: 'ssl/tls alert unexpected message',
  20: 'ssl/tls alert bad record mac',
  21: 'tlsv1 alert decryption failed',
  22: 'tlsv1 alert record overflow',
  30: 'ssl/tls alert decompression failure',
  40: 'ssl/tls alert handshake failure',
  41: 'ssl/tls alert no certificate',
  42: 'ssl/tls alert bad certificate',
  43: 'ssl/tls alert unsupported certificate',
  44: 'ssl/tls alert certificate revoked',
  45: 'ssl/tls alert certificate expired',
  46: 'ssl/tls alert certificate unknown',
  47: 'ssl/tls alert illegal parameter',
  48: 'tlsv1 alert unknown ca',
  49: 'tlsv1 alert access denied',
  50: 'tlsv1 alert decode error',
  51: 'tlsv1 alert decrypt error',
  60: 'tlsv1 alert export restriction',
  70: 'tlsv1 alert protocol version',
  71: 'tlsv1 alert insufficient security',
  80: 'tlsv1 alert internal error',
  86: 'tlsv1 alert inappropriate fallback',
  90: 'tlsv1 alert user cancelled',
  100: 'tlsv1 alert no renegotiation',
  109: 'tlsv13 alert missing extension',
  110: 'tlsv1 unsupported extension',
  111: 'tlsv1 certificate unobtainable',
  112: 'tlsv1 unrecognized name',
  113: 'tlsv1 bad certificate status response',
  114: 'tlsv1 bad certificate hash value',
  115: 'tlsv1 alert unknown psk identity',
  116: 'tlsv13 alert certificate required',
  120: 'tlsv1 alert no application protocol',
};

// OpenSSL 3.0's X509_verify_cert_error_string for the codes a check gives.
const VERIFY_MESSAGES = {
  UNABLE_TO_GET_ISSUER_CERT: 'unable to get issuer certificate',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'unable to get local issuer certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'unable to verify the first certificate',
  SELF_SIGNED_CERT_IN_CHAIN: 'self-signed certificate in certificate chain',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed certificate',
  CERT_HAS_EXPIRED: 'certificate has expired',
  CERT_NOT_YET_VALID: 'certificate is not yet valid',
  CERT_REVOKED: 'certificate revoked',
  INVALID_PURPOSE: 'unsuitable certificate purpose',
  CERT_SIGNATURE_FAILURE: 'certificate signature failure',
};

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

export function createTls({ ctx, process, Buffer, net, getCrypto, getFs }) {
  // ctx.net.connect's `tls`: HTTP/1.1 and WebSocket over TLS through the
  // embedder's transport, which does the handshake and verifies the peer
  // (ai-ecoverse/slicc-kernel#923); to a host the uplink routes, the
  // kernel's own handshake (any port and protocol, a custom ca, STARTTLS, a
  // client certificate, `sni: false`), which hands over the session:
  // protocol, ALPN, its verdict, the cipher and the server's chain
  // (ai-ecoverse/slicc-kernel#922, #1004).
  const kernelTls = typeof ctx?.net?.connect === 'function';
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
  const tlsKeylog = optionValue('--tls-keylog');
  let warnOnTlsKeylog = true;
  let warnOnTlsKeylogError = true;

  const wantsKeylog = (socket) => socket.listenerCount('keylog') > 0;

  function emitKeylog(socket, session) {
    for (const line of session?.keylog ?? []) socket.emit('keylog', Buffer.from(`${line}\n`, 'latin1'));
  }

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
      if (!kernelTls) refuse('ca');
      context[kCa] = Array.isArray(ca) ? [...ca] : [ca];
    }
    if (cert) {
      const certs = Array.isArray(cert) ? cert : [cert];
      for (const c of certs) validateKeyOrCertOption(`${name}.cert`, c);
      if (!kernelTls) refuse('cert');
      // Text with no certificate in it is OpenSSL's PEM error, here as there.
      const pemError = pemCertError(certs[0]);
      if (pemError) throw osslError(pemError);
      context[kOwnCert] = { cert: certs, leaf: caCertificates(certs)[0] };
    }
    if (key) {
      if (!kernelTls) refuse('key');
      // One key: a key per algorithm (RSA and EC) is OpenSSL's choice to make.
      const keys = Array.isArray(key) ? key : [key];
      if (keys.length > 1) throw noTls(`tls.createSecureContext option 'key' with more than one key`, 'the kernel takes one client key');
      const pem = keys[0]?.pem !== undefined ? keys[0].pem : keys[0];
      const pass = keys[0]?.passphrase !== undefined ? keys[0].passphrase : options.passphrase;
      validateKeyOrCertOption(`${name}.key`, pem);
      if (pass !== undefined && pass !== null) validateString(pass, `${name}.passphrase`);
      // What isn't a key at all, a DER key and a wrong passphrase fail here, as in Node.
      if (!isKeyMaterial(pem)) throw osslError('ERR_OSSL_UNSUPPORTED');
      const locked = lockedKeyError(pem, pass ?? '', getCrypto(), Buffer);
      if (locked) throw osslError(locked.code, locked.stack);
      context[kOwnKey] = { key: pem, ...(pass !== undefined && pass !== null ? { passphrase: pass } : {}) };
    }
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

  /** OpenSSL's PEM error for a certificate that isn't one (DER passes), or undefined. */
  function pemCertError(cert) {
    if (typeof cert !== 'string' && cert[0] === 0x30) return undefined;
    const text = typeof cert === 'string' ? cert : Buffer.from(cert.buffer, cert.byteOffset, cert.byteLength).toString('latin1');
    if (!text.includes('-----BEGIN ')) return 'ERR_OSSL_PEM_NO_START_LINE';
    return /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.test(text) ? undefined : 'ERR_OSSL_PEM_BAD_END_LINE';
  }

  /** A key as PEM (PKCS#8, encrypted or not, PKCS#1 or SEC1): what Node's tls reads. */
  function isKeyMaterial(key) {
    const text = typeof key === 'string' ? key : Buffer.from(key.buffer, key.byteOffset, key.byteLength).toString('latin1');
    return /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(text);
  }

  /**
   * The kernel's client certificate from a context: only with both a
   * certificate and a key, as OpenSSL sends one only then.
   */
  function clientCredentials(context) {
    const cert = context?.[kOwnCert];
    const key = context?.[kOwnKey];
    return cert && key ? { cert: cert.cert, ...key } : undefined;
  }

  function createSecureContext(options) {
    options ||= {};
    const { honorCipherOrder, minVersion, maxVersion, secureProtocol } = options;
    let { secureOptions } = options;
    if (honorCipherOrder) secureOptions |= SSL_OP_CIPHER_SERVER_PREFERENCE;
    const c = new SecureContext(secureProtocol, secureOptions, minVersion, maxVersion);
    configSecureContext(c.context, options);
    const own = clientCredentials(c.context);
    const refused = own && typeof ctx?.sync?.net?.listen === 'function' ? leafRefusal(own) : null;
    if (refused?.code === 'ERR_OSSL_X509_KEY_VALUES_MISMATCH' || refused?.code === 'ERR_OSSL_BAD_DECRYPT') throw refused;
    c.context[kLeafRefusal] = refused;
    return c;
  }

  // --- The kernel's session (slicc-kernel 1.124.0) --------------------------
  const digest = (algorithm, bytes) => getCrypto().createHash(algorithm).update(bytes).digest('hex');
  const PEM = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;

  /** A `ca` option's certificates, parsed (for the chain Node shows). */
  function caCertificates(ca) {
    const out = [];
    for (const item of ca ?? []) {
      const bytes = typeof item === 'string' ? undefined : Buffer.from(item.buffer, item.byteOffset, item.byteLength);
      const ders = bytes && bytes[0] === 0x30 ? [bytes] : [...String(bytes ? bytes.toString('latin1') : item).matchAll(PEM)].map((m) => Buffer.from(m[1].replace(/\s+/g, ''), 'base64'));
      for (const der of ders) {
        try {
          out.push(parseCertificate(der));
        } catch {
          /* not a certificate: the kernel says so at connect */
        }
      }
    }
    return out;
  }

  /** The server's chain from the kernel's session (DER, leaf first), parsed once. */
  function peerChain(socket) {
    const session = socket[kTlsSession];
    if (session?.path !== 'kernel' || !session.peerCertificates?.length) return undefined;
    if (socket[kPeerChain] === undefined) {
      try {
        socket[kPeerChain] = session.peerCertificates.map((der) => parseCertificate(der));
      } catch {
        // A certificate jsh can't read: the kernel's verdict stands alone.
        socket[kPeerChain] = null;
      }
    }
    return socket[kPeerChain] ?? undefined;
  }

  /** GetPeerCert: the leaf, and with `detailed` its issuers as Node links them. */
  function peerCertificate(socket, detailed) {
    const chain = peerChain(socket);
    if (!chain) return {};
    const object = (c) => certificateObject(c, { Buffer, digest });
    const leaf = object(chain[0]);
    if (!detailed) return leaf;
    // AddIssuerChainToObject: the issuers the server sent.
    const rest = chain.slice(1);
    let cert = chain[0];
    let last = leaf;
    for (;;) {
      const i = rest.findIndex((ca) => isIssuedBy(cert, ca));
      if (i === -1) break;
      const next = object(rest[i]);
      last.issuerCertificate = next;
      last = next;
      cert = rest[i];
      rest.splice(i, 1);
    }
    // GetLastIssuedCert: then the trust store's (a `ca` the program gave).
    const store = socket[kStore] ?? [];
    while (!isIssuedBy(cert, cert)) {
      const ca = store.find((c) => isIssuedBy(cert, c));
      if (!ca) break;
      const next = object(ca);
      last.issuerCertificate = next;
      last = next;
      if (ca === cert) break;
      cert = ca;
    }
    if (isIssuedBy(cert, cert)) last.issuerCertificate = last;
    return leaf;
  }

  /**
   * What OpenSSL calls a chain that reaches no trusted root (the kernel says
   * UNABLE_TO_GET_ISSUER_CERT_LOCALLY for each): by the chain the server sent.
   */
  function untrusted(chain) {
    const linked = [chain[0]];
    const rest = chain.slice(1);
    for (;;) {
      const top = linked[linked.length - 1];
      if (likelyIssued(top, top)) break;
      const i = rest.findIndex((ca) => likelyIssued(top, ca));
      if (i === -1) break;
      linked.push(rest.splice(i, 1)[0]);
    }
    const top = linked[linked.length - 1];
    if (likelyIssued(top, top)) return linked.length === 1 ? 'DEPTH_ZERO_SELF_SIGNED_CERT' : 'SELF_SIGNED_CERT_IN_CHAIN';
    return linked.length === 1 ? 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' : 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY';
  }

  const SERVER_AUTH = ['1.3.6.1.5.5.7.3.1', '2.5.29.37.0'];

  /**
   * Node's onConnectSecure on the kernel's verdict: the chain's error (in
   * OpenSSL's words), else `checkServerIdentity` on the certificate.
   */
  function verifyError(socket, session, options) {
    const chain = peerChain(socket);
    const hostname = options.servername || options.host || options.socket?._host || 'localhost';
    // slicc-kernel 1.125.2 (ai-ecoverse/slicc-kernel#1057): the session says
    // the chain's verdict apart from the name (chainError, in Node's words)
    // and the name's (hostnameMatches). The name is then checkServerIdentity's.
    if (session.hostnameMatches !== undefined) {
      const code = session.chainError;
      if (code) return Object.assign(new Error(VERIFY_MESSAGES[code] ?? code), { code });
      if (chain) return options.checkServerIdentity(hostname, peerCertificate(socket, true));
      // A chain jsh can't read: the kernel's check of the name.
      return session.hostnameMatches === false
        ? nodeError(Error, 'ERR_TLS_CERT_ALTNAME_INVALID', "Hostname/IP does not match certificate's altnames")
        : undefined;
    }
    // Before 1.125.2, one verdict for both: jsh tells them apart.
    let code = session.authorizationError;
    // A chain jsh can't read: the kernel's verdict, the name's included.
    if (!chain && session.peerCertificates?.length) {
      if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
        return nodeError(Error, code, "Hostname/IP does not match certificate's altnames");
      }
      return code ? Object.assign(new Error(VERIFY_MESSAGES[code] ?? code), { code }) : undefined;
    }
    // The name is checkServerIdentity's to judge, as in Node.
    if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
      code = chain?.[0]?.eku && !chain[0].eku.some((e) => SERVER_AUTH.includes(e)) ? 'INVALID_PURPOSE' : undefined;
    }
    if (code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' && chain) code = untrusted(chain);
    if (code) return Object.assign(new Error(VERIFY_MESSAGES[code] ?? code), { code });
    if (!chain) return undefined;
    return options.checkServerIdentity(hostname, peerCertificate(socket, true));
  }

  /**
   * The session on the socket, as Node's _finishInit and (for tls.connect,
   * `options`) onConnectSecure leave it. Returns the error to destroy with.
   */
  function takeSession(socket, session, options) {
    emitKeylog(socket, session);
    socket._secureEstablished = true;
    socket.secureConnecting = false;
    socket.alpnProtocol = session.alpnProtocol || false;
    // Node's: the SNI it sent (servername), else false.
    if (socket.servername === null) socket.servername = options?.servername || false;
    if (!options) return undefined;
    // The transport's session (A1): it verified the server, and keeps the certificates.
    if (session.path !== 'kernel') {
      socket.authorized = session.authorized === true;
      socket.authorizationError = socket.authorized ? null : 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
      return undefined;
    }
    let err;
    try {
      err = verifyError(socket, session, options);
    } catch (thrown) {
      // Node's checkServerIdentity throws out of onConnectSecure: the
      // session is refused here, and 'secure' throws it on.
      socket[kThrown] = thrown;
      return thrown;
    }
    if (err) {
      socket.authorized = false;
      socket.authorizationError = err.code || err.message;
      if (options.rejectUnauthorized !== false) return err;
    } else {
      socket.authorized = true;
    }
    return undefined;
  }

  /** The kernel's `tls` for a connect: verification is jsh's (Node's rule, above). */
  function kernelRequest(options, servername, ca) {
    const alpn = alpnNames(options.ALPNProtocols);
    return {
      ...(servername ? { servername } : {}),
      ...(alpn ? { alpn } : {}),
      rejectUnauthorized: false,
      ...(ca ? { ca } : {}),
    };
  }

  /**
   * What only the kernel's own handshake does: the client certificate, and
   * no SNI where Node sends none. Node sends one
   * only for tls.connect's `servername` (not the host, and never a bare
   * TLSSocket's); the kernel still checks the certificate against the name.
   */
  function kernelControlsOf(context, sni) {
    const own = clientCredentials(context?.context);
    return { ...(sni ? {} : { sni: false }), ...(own ?? {}) };
  }

  /** Node's ConnResetException for a server that left during the handshake. */
  function handshakeReset(options) {
    const error = new Error('Client network socket disconnected before secure TLS connection was established');
    error.code = 'ECONNRESET';
    error.path = options.path;
    error.host = options.host;
    error.port = options.port;
    error.localAddress = options.localAddress;
    return error;
  }

  /** A kernel refusal as Node's error (or ERR_NOT_SUPPORTED for what it won't do). */
  function refusal(err, { what, options, ca, own, overSocket }) {
    const code = err?.code ?? err?.cause?.code;
    // The key's errors (the engine's, before anything is dialled) as Node's.
    // Without a passphrase OpenSSL decrypts with an empty one: a bad decrypt.
    if (code === 'ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED') return osslError('ERR_OSSL_BAD_DECRYPT');
    if (typeof code === 'string' && Object.hasOwn(OSSL_ERRORS, code)) return osslError(code);
    if (code === 'EPROTONOSUPPORT') {
      return noTls(what, "the kernel's TLS to a host its uplink doesn't route goes through its transport, which carries HTTP/1.1 and WebSocket only");
    }
    // Over a socket, sni: false (or a client certificate) takes the kernel's
    // own path, which says ENOTSUP for a connection its uplink doesn't route.
    if (code === 'ENOTSUP' && overSocket) return noTls(what, "the kernel upgrades only a plain connection its uplink routes");
    if (code === 'ENOTSUP') {
      if (own) return noTls(what, "a client certificate needs a host the kernel's uplink routes");
      if (ca) return noTls(what, "a custom ca needs a host the kernel's uplink routes");
      return noTls(what, "the kernel's TLS goes through its transport, which has no loopback");
    }
    if (code === 'EOPNOTSUPP' || (overSocket && code === 'EINVAL' && !err?.detail)) {
      return noTls(what, "the kernel upgrades only a plain connection its uplink routes");
    }
    if (code === 'EINVAL') return noTls(what, `the kernel's TLS refuses the server name (${err?.detail ?? 'not a host name'})`);
    if (code === 'ECONNRESET') return readReset(err) ?? handshakeReset(options);
    if (typeof code === 'string' && Object.hasOwn(VERIFY_MESSAGES, code)) {
      return Object.assign(new Error(VERIFY_MESSAGES[code]), { code });
    }
    if (typeof code === 'string' && code.startsWith('ERR_SSL_')) return sslError(code, err.detail ?? err.message, err.alert ?? err.cause?.alert);
    if (typeof code === 'string' && code.startsWith('ERR_')) {
      return Object.assign(new Error(err.detail ?? err.message), { code });
    }
    return undefined;
  }

  /**
   * The kernel's TLS failure (ERR_SSL_HANDSHAKE_FAILURE, ERR_SSL_FATAL_ALERT)
   * shaped as Node's OpenSSL errors: `library`, `reason` (whose words the
   * code is), `code`. For the server's alert (its number in `alert`, or the
   * detail's ` (alert n)`, slicc-kernel 1.125.2), OpenSSL's reason names it,
   * as Node's does: ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED. Node's message
   * also has its thread and source position, which jsh can't give.
   */
  function sslError(code, detail, alert) {
    const n = Number.isInteger(alert) ? alert : Number(/ \(alert (\d+)\)$/.exec(String(detail ?? ''))?.[1]);
    if (Object.hasOwn(ALERT_REASONS, n)) {
      const reason = ALERT_REASONS[n];
      const id = (0x0a000000 + 1000 + n).toString(16).toUpperCase().padStart(8, '0');
      const err = new Error(`error:${id}:SSL routines:ssl3_read_bytes:${reason}:SSL alert number ${n}`);
      return Object.assign(err, { library: 'SSL routines', reason, code: `ERR_SSL_${reason.toUpperCase().replaceAll(' ', '_')}` });
    }
    const record = RECORD_FAILURES[code];
    if (record) {
      const reason = code.slice('ERR_SSL_'.length).toLowerCase().replaceAll('_', ' ');
      const err = new Error(`error:${record[0]}:SSL routines:${record[1]}:${reason}`);
      return Object.assign(err, { library: 'SSL routines', reason, code });
    }
    const err = new Error(String(detail ?? code).replace(/^ERR_SSL_[A-Z_]+: /, ''));
    const reason = code.slice('ERR_SSL_'.length).toLowerCase().replaceAll('_', ' ');
    return Object.assign(err, { library: 'SSL routines', reason, code });
  }

  const RECORD_FAILURES = {
    __proto__: null,
    ERR_SSL_PACKET_LENGTH_TOO_LONG: ['0A0000C6', 'tls_get_more_records'],
    ERR_SSL_WRONG_VERSION_NUMBER: ['0A00010B', 'tls_validate_record_header'],
    ERR_SSL_HTTP_REQUEST: ['0A00009C', 'tls_validate_record_header'],
    ERR_SSL_DATA_LENGTH_TOO_LONG: ['0A000092', 'tls_validate_record_header'],
    ERR_SSL_UNEXPECTED_MESSAGE: ['0A0000F4', 'ossl_statem_client_read_transition'],
  };

  /** A failed read or write on the kernel's session as Node's error, or undefined. */
  function sessionError(err) {
    const code = err?.code ?? err?.cause?.code;
    if (typeof code !== 'string' || !code.startsWith('ERR_SSL_')) return undefined;
    return sslError(code, err.detail ?? err.cause?.detail, err.alert ?? err.cause?.alert);
  }

  const SERVER_FAILURES = [
    [/No client certification received/, 'C7', 'peer did not return a certificate'],
    [/No ALPN protocols supported/, 'EB', 'no application protocol'],
  ];

  function sslReason(id, reason) {
    const err = new Error(`error:0A0000${id}:SSL routines::${reason}`);
    return Object.assign(err, { library: 'SSL routines', reason, code: `ERR_SSL_${reason.toUpperCase().replaceAll(' ', '_')}` });
  }

  function readReset(err) {
    const code = err?.code ?? err?.cause?.code;
    const detail = String(err?.detail ?? err?.cause?.detail ?? '');
    if (code !== 'ECONNRESET' || !/\bread ECONNRESET\b/.test(detail)) return undefined;
    return Object.assign(new Error('read ECONNRESET'), { errno: -ERRNO.ECONNRESET, code, syscall: 'read' });
  }

  function serverRefusal(err) {
    const code = err?.code ?? err?.cause?.code;
    const detail = String(err?.detail ?? err?.cause?.detail ?? '');
    if (code === 'ERR_TLS_HANDSHAKE_TIMEOUT') return nodeError(Error, code, 'TLS handshake timeout');
    const reset = readReset(err);
    if (reset) return reset;
    for (const [pattern, id, reason] of SERVER_FAILURES) if (pattern.test(detail)) return sslReason(id, reason);
    if (code === 'ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED') return osslError('ERR_OSSL_BAD_DECRYPT');
    if (typeof code === 'string' && Object.hasOwn(OSSL_ERRORS, code)) return osslError(code);
    if (typeof code === 'string' && code.startsWith('ERR_SSL_') && !/Certificate verification failed/.test(detail)) {
      return sslError(code, detail, err.alert ?? err.cause?.alert);
    }
    return null;
  }

  function serverRequest(context, options, select) {
    const own = context?.[kOwnCert];
    const key = context?.[kOwnKey];
    if ((!own || !key) && !select) return undefined;
    const alpn = select ? undefined : alpnNames(options.ALPNProtocols);
    return {
      server: true,
      ...(own && key ? { cert: own.cert, ...key } : {}),
      ...(select ? { select } : {}),
      ...(context[kCa] ? { ca: context[kCa] } : {}),
      ...(options.requestCert ? { requestCert: true } : {}),
      ...(options.rejectUnauthorized ? {} : { rejectUnauthorized: false }),
      ...(alpn ? { alpn } : {}),
      ...(options.handshakeTimeout > 0 ? { handshakeTimeout: options.handshakeTimeout } : {}),
    };
  }

  const kernelContexts = new Map();

  function holdContext(context) {
    let held = kernelContexts.get(context);
    if (!held) {
      held = { made: ctx.net.tlsContext(clientCredentials(context)), users: 0 };
      held.made.catch(() => {});
      kernelContexts.set(context, held);
    }
    held.users++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (--held.users > 0) return;
      if (kernelContexts.get(context) === held) kernelContexts.delete(context);
      held.made.then((made) => made.close(), () => {}).catch(() => {});
    };
    return { made: held.made, release };
  }

  function sameTrust(a, b) {
    if (!a || !b) return !a && !b;
    const text = (c) => (typeof c === 'string' ? c : Buffer.from(c.buffer, c.byteOffset, c.byteLength).toString('latin1'));
    return a.length === b.length && a.every((c, i) => text(c) === text(b[i]));
  }

  function SNICallback(servername, callback) {
    const contexts = this.server._contexts;
    for (let i = contexts.length - 1; i >= 0; --i) {
      if (contexts[i][0].test(servername)) {
        callback(null, contexts[i][1]);
        return;
      }
    }
    callback(null, undefined);
  }

  function clientVerifyError(socket, session) {
    if (session?.authorized === true) return undefined;
    if (!session?.peerCertificates?.length) return 'UNABLE_TO_GET_ISSUER_CERT';
    const chain = peerChain(socket);
    const code = session.authorizationError;
    if (code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' && chain) return untrusted(chain);
    return code || 'UNABLE_TO_GET_ISSUER_CERT';
  }

  // --- _tls_wrap.js: TLSSocket --------------------------------------------
  class TLSSocket extends net.Socket {
    constructor(socket, opts) {
      const tlsOptions = { ...opts };
      if (tlsOptions.enableTrace != null) validateBoolean(tlsOptions.enableTrace, 'options.enableTrace');
      if (tlsOptions.ALPNProtocols) convertALPNProtocols(tlsOptions.ALPNProtocols, tlsOptions);
      if (socket) {
        if (!kernelTls) throw noTls('tls.TLSSocket over a socket');
        if (tlsOptions.isServer && typeof ctx.net.secure !== 'function') {
          throw noTls('tls.TLSSocket over a socket as a server', "the kernel's TLS is a client's");
        }
        if (!(socket instanceof net.Socket) || typeof socket[kDetach] !== 'function') {
          throw noTls('tls.TLSSocket over a stream that is not a net.Socket', 'the kernel upgrades its own connections');
        }
      }
      super({ allowHalfOpen: socket ? socket.allowHalfOpen : tlsOptions.allowHalfOpen, ...(socket ? { emitClose: false } : {}) });
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
      this[kALPNCallback] = null;
      this.server = tlsOptions.server;
      if (tlsKeylog) {
        if (warnOnTlsKeylog) {
          warnOnTlsKeylog = false;
          process.emitWarning(`Using --tls-keylog makes TLS connections insecure by writing secret key material to file ${tlsKeylog}`);
        }
        this.on('keylog', (line) => {
          getFs().appendFile(tlsKeylog, line, { mode: 0o600 }, (err) => {
            if (err && warnOnTlsKeylogError) {
              warnOnTlsKeylogError = false;
              process.emitWarning(`Failed to write TLS keylog (this warning will not be repeated): ${err}`);
            }
          });
        });
      }
      if (tlsOptions.isServer) {
        this._requestCert = Boolean(tlsOptions.requestCert);
        this._rejectUnauthorized = Boolean(tlsOptions.rejectUnauthorized);
        this.on('error', this._tlsError);
        if (tlsOptions.ALPNCallback) {
          validateFunction(tlsOptions.ALPNCallback, 'options.ALPNCallback');
          this[kALPNCallback] = tlsOptions.ALPNCallback;
        }
        const sni = tlsOptions.SNICallback;
        if (sni && (sni !== SNICallback || tlsOptions.server?._contexts.length)) {
          validateFunction(sni, 'options.SNICallback');
          this._SNICallback = sni;
        }
      }
      if (socket && tlsOptions.isServer) this.#serve(socket);
      else if (socket) this.#over(socket);
    }

    [kIpc](keepOpen) {
      if (this.destroyed) return undefined;
      return { ...super[kIpc](keepOpen), tls: true };
    }

    #serve(socket) {
      this._parent = socket;
      socket.on('error', (err) => {
        if (!this.destroyed) this.destroy(err);
      });
      const tlsOptions = this._tlsOptions;
      const context = (tlsOptions.secureContext ?? createSecureContext(tlsOptions)).context;
      this[kStore] = caCertificates(context[kCa]);
      this[kOwnLeaf] = context[kOwnCert]?.leaf;
      this[kHeld] = [];
      const bare = !clientCredentials(context);
      const selects = this._SNICallback || this[kALPNCallback] || bare;
      const request = serverRequest(context, tlsOptions, selects ? (offer) => this.#select(offer, context) : undefined);
      this[kStartTls](socket, {
        server: true,
        dial: () => ({ tls: wantsKeylog(this) ? { ...request, keylog: true } : request }),
        settled: () => {
          this[kHeld].settled = true;
          for (const release of this[kHeld].splice(0)) release();
        },
        check: (session) => {
          emitKeylog(this, session);
          this._secureEstablished = true;
          this.alpnProtocol = session.alpnProtocol || false;
          this.servername = session.servername || false;
        },
        refused: (err) => {
          if (this[kRefusal]) return this[kRefusal];
          if (bare && (err?.code ?? err?.cause?.code) === 'EIO') return sslReason('76', 'no suitable signature algorithm');
          return serverRefusal(err);
        },
        keeps: (err) => err.code === 'ERR_TLS_HANDSHAKE_TIMEOUT',
        kept: (err) => this._tlsError(err),
        secured: () => this.emit('secure'),
      });
    }

    async #select(offer, context) {
      const servername = offer.servername;
      const protocols = [...offer.protocols];
      let alpn;
      if (this[kALPNCallback]) {
        if (protocols.length) {
          try {
            alpn = this[kALPNCallback]({ servername: servername || false, protocols });
          } catch (err) {
            return this.#drop(err);
          }
          if (alpn === undefined) return this.#refuse('no_application_protocol', sslReason('EB', 'no application protocol'));
          if (!protocols.includes(alpn)) {
            return this.#drop(nodeError(TypeError, 'ERR_TLS_ALPN_CALLBACK_INVALID_RESULT',
              `ALPN callback returned a value (${alpn}) that did not match any of the client's offered protocols (${protocols.join(', ')})`));
          }
        }
      } else {
        const mine = alpnNames(this._tlsOptions.ALPNProtocols);
        if (mine && protocols.length) {
          alpn = mine.find((name) => protocols.includes(name));
          if (alpn === undefined) return this.#refuse('no_application_protocol', sslReason('EB', 'no application protocol'));
        }
      }
      let chosen;
      if (this._SNICallback && servername) {
        try {
          const picked = await this.#sni(servername);
          chosen = picked?.context || picked;
        } catch (err) {
          return this.#drop(err);
        }
      }
      if (this.destroyed || this[kHeld].settled) return kDropHandshake;
      if (chosen && this._requestCert && !sameTrust(chosen[kCa], context[kCa])) {
        return this.#drop(noTls(
          "a client certificate checked against the ca of the context SNICallback or addContext chose",
          "the kernel checks it against the server's own ca"
        ));
      }
      const own = chosen && clientCredentials(chosen) ? chosen : undefined;
      if (!own && !clientCredentials(context)) return this.#refuse('handshake_failure', sslReason('76', 'no suitable signature algorithm'));
      let made;
      if (own) {
        const held = holdContext(own);
        this[kHeld].push(held.release);
        try {
          made = await held.made;
        } catch (err) {
          return this.#drop(serverRefusal(err) ?? err);
        }
        this[kOwnLeaf] = own[kOwnCert].leaf;
      }
      return { ...(made ? { context: made } : {}), ...(alpn !== undefined ? { alpn } : {}) };
    }

    #sni(servername) {
      return new Promise((resolve, reject) => {
        let once = false;
        this._SNICallback(servername, (err, context) => {
          if (once) {
            this.destroy(nodeError(Error, 'ERR_MULTIPLE_CALLBACK', 'Callback called multiple times'));
            return;
          }
          once = true;
          if (err) reject(err);
          else resolve(context);
        });
      });
    }

    #refuse(refuse, err) {
      this[kRefusal] = err;
      return { refuse };
    }

    #drop(err) {
      if (!this.destroyed) this.destroy(err);
      return kDropHandshake;
    }

    _tlsError(err) {
      this.emit('_tlsError', err);
      return this._controlReleased ? err : null;
    }

    _releaseControl() {
      if (this._controlReleased) return false;
      this._controlReleased = true;
      return true;
    }

    /** STARTTLS: the handshake over `socket`, at the first write or `_start()`. */
    #over(socket) {
      this._parent = socket;
      this.connecting = socket.connecting || !socket._isConnected();
      socket.once('connect', () => {
        this.connecting = false;
        this.emit('connect');
      });
      socket.on('error', (err) => {
        if (!this.destroyed) this.destroy(err);
      });
      const tlsOptions = this._tlsOptions;
      const optionsNow = () => this[kConnectOptions];
      let ca;
      let own;
      this[kStartTls](socket, {
        lazy: true,
        dial: () => {
          const options = optionsNow() ?? tlsOptions;
          const context = tlsOptions.secureContext ?? options.secureContext;
          ca = options.ca ? (Array.isArray(options.ca) ? options.ca : [options.ca]) : context?.context?.[kCa];
          this[kStore] = caCertificates(ca);
          this[kOwnLeaf] = context?.context?.[kOwnCert]?.leaf;
          own = clientCredentials(context?.context);
          const servername = options.servername || tlsOptions.servername || options.host || socket._host;
          const tls = kernelRequest({ ...options, ALPNProtocols: tlsOptions.ALPNProtocols }, servername, ca);
          const keylog = wantsKeylog(this) ? { keylog: true } : {};
          return { host: options.host ?? socket._host, tls: { ...tls, ...kernelControlsOf(context, optionsNow()?.servername), ...keylog } };
        },
        check: (session) => takeSession(this, session, optionsNow()),
        refusedSession: (err) => {
          this[kVerifyError] = err;
        },
        refused: (err) => refusal(err, { what: 'tls.connect over a socket', options: optionsNow() ?? {}, ca, own, overSocket: true }),
        // A throwing listener (onConnectSecure's checkServerIdentity) is uncaught, as in Node.
        secured: () => {
          try {
            this.emit('secure');
          } catch (err) {
            process.nextTick(() => {
              throw err;
            });
          }
        },
      });
    }

    /** Node's: start the handshake now (tls.connect over a socket does). */
    _start() {
      this[kStartNow]();
    }

    resetAndDestroy() {
      if (!this.destroyed) throw nodeError(TypeError, 'ERR_INVALID_HANDLE_TYPE', 'This handle type cannot be sent');
      return super.resetAndDestroy();
    }

    _destroy(err, callback) {
      const parent = this._parent;
      super._destroy(err, (e) => {
        if (!parent) return callback(e);
        // Node's TLSWrap#close: the socket under it goes, then this one's 'close'.
        const closed = () => this.emit('close', Boolean(err));
        if (parent._readableState?.closeEmitted) process.nextTick(closed);
        else {
          parent.once('close', closed);
          if (!parent.destroyed) parent.destroy();
        }
        callback(e);
      });
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

    // Without a session, what Node's TLSSocket answers without a handle.
    // The kernel's handshake (slicc-kernel 1.124.0) hands over the server's
    // chain; the transport's (A1) keeps the certificates, so it's {}.
    getPeerCertificate(detailed) {
      return this._secureEstablished ? peerCertificate(this, Boolean(detailed)) : null;
    }
    // Node's: the certificate the context has, sent or not (the kernel's
    // handshake, slicc-kernel 1.124.13, takes one).
    getCertificate() {
      if (!this._secureEstablished) return null;
      const leaf = this[kTlsSession]?.path === 'kernel' ? this[kOwnLeaf] : undefined;
      return leaf ? certificateObject(leaf, { Buffer, digest }) : {};
    }
    // The suite as Node's getCipher() says it, from the kernel's session.
    getCipher() {
      const cipher = this._secureEstablished ? this[kTlsSession]?.cipher : undefined;
      return cipher ? { name: cipher.name, standardName: cipher.standardName, version: cipher.version } : null;
    }
    // A read or write the kernel's session fails (a fatal alert) as Node's error.
    [kIoError](err) {
      return this[kTlsSession]?.path === 'kernel' ? sessionError(err) : undefined;
    }
    getPeerX509Certificate() {
      return undefined;
    }
    getX509Certificate() {
      return undefined;
    }
    // The kernel's handshake says its version; the transport's has none of its own.
    getProtocol() {
      const session = this[kTlsSession];
      return this._secureEstablished && session?.path === 'kernel' ? session.protocol : null;
    }
    // The kernel resumes no session.
    isSessionReused() {
      return this._secureEstablished && this[kTlsSession]?.path === 'kernel' ? false : null;
    }
  }
  for (const method of [
    'getSharedSigalgs',
    'getEphemeralKeyInfo',
    'getFinished',
    'getPeerFinished',
    'getSession',
    'getTLSTicket',
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
    self.on('connection', tlsConnectionListener);
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
    self[kHandshakeTimeout] = handshakeTimeout;
    self[kServesTls] = true;
    if (options.SNICallback) validateFunction(options.SNICallback, 'options.SNICallback');
    self[kSNICallback] = options.SNICallback;
    if (options.pskCallback) validateFunction(options.pskCallback, 'options.pskCallback');
    if (options.pskIdentityHint) validateString(options.pskIdentityHint, 'options.pskIdentityHint');
    if (listener) self.on('secureConnection', listener);
    return self;
  }
  function tlsConnectionListener(rawSocket) {
    if (rawSocket instanceof net.Socket && typeof rawSocket[kDetach] === 'function' && typeof ctx?.net?.secure === 'function') {
      const socket = new TLSSocket(rawSocket, {
        secureContext: this._sharedCreds,
        isServer: true,
        server: this,
        requestCert: this.requestCert,
        rejectUnauthorized: this.rejectUnauthorized,
        handshakeTimeout: this[kHandshakeTimeout],
        ALPNProtocols: this.ALPNProtocols,
        ALPNCallback: this.ALPNCallback,
        SNICallback: this[kSNICallback] || SNICallback,
      });
      socket.on('secure', onServerSocketSecure);
      if (this.listenerCount('keylog') > 0) socket.on('keylog', onSocketKeylog);
      socket[kErrorEmitted] = false;
      socket.on('close', onSocketClose);
      socket.on('_tlsError', onSocketTLSError);
      return;
    }
    const err = noTls('tls.Server connection', 'the kernel secures its own connections');
    rawSocket.on?.('error', () => {});
    process.nextTick(() => {
      rawSocket.destroy?.();
      this.emit('tlsClientError', err, rawSocket);
    });
  }
  function onSocketKeylog(line) {
    this._tlsOptions.server.emit('keylog', line, this);
  }
  function onServerSocketSecure() {
    if (this._requestCert) {
      const code = clientVerifyError(this, this[kTlsSession]);
      if (code) {
        this.authorizationError = code;
        if (this._rejectUnauthorized) this.destroy();
      } else {
        this.authorized = true;
      }
    }
    if (!this.destroyed && this._releaseControl()) {
      this.secureConnecting = false;
      this._tlsOptions.server.emit('secureConnection', this);
    }
  }
  function onSocketTLSError(err) {
    if (!this._controlReleased && !this[kErrorEmitted]) {
      this[kErrorEmitted] = true;
      this._tlsOptions.server.emit('tlsClientError', err, this);
    }
  }
  function onSocketClose(err) {
    if (err) return;
    if (!this._controlReleased && !this[kErrorEmitted]) {
      this[kErrorEmitted] = true;
      this._tlsOptions.server.emit('tlsClientError', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), this);
    }
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
      if (this._sharedCreds.context[kLeafRefusal]) throw this._sharedCreds.context[kLeafRefusal];
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
      if (secureContext.context[kLeafRefusal]) throw secureContext.context[kLeafRefusal];
      this._contexts.push([re, secureContext.context]);
    },
    listen(...args) {
      if (typeof ctx?.net?.secure !== 'function') throw noTls('tls.Server.listen');
      return Reflect.apply(net.Server.prototype.listen, this, args);
    },
  };
  for (const [k, v] of Object.entries(serverMethods)) {
    Object.defineProperty(Server.prototype, k, { value: v, writable: true, configurable: true, enumerable: false });
  }

  function createServer(options, listener) {
    return new Server(options, listener);
  }

  function leafRefusal({ cert, key, passphrase }) {
    let listener;
    try {
      listener = ctx.sync.net.listen({ host: '127.0.0.1', port: 0, backlog: 1, tls: { cert, key, ...(passphrase !== undefined ? { passphrase } : {}) } });
    } catch (err) {
      const code = /^ERR_OSSL_[A-Z0-9_]+/.exec(String(err?.detail ?? ''))?.[0];
      return code ? serverRefusal({ code }) : null;
    }
    void Promise.resolve(listener.close?.()).catch(() => {});
    return null;
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

  // The session's verdict is in (takeSession): 'secureConnect' follows 'secure'.
  function onConnectSecure() {
    const err = this[kVerifyError];
    if (err && err === this[kThrown]) {
      // Out of the 'secure' listener, so later ones don't run: uncaught, as in Node.
      this[kVerifyError] = undefined;
      throw err;
    }
    if (err) {
      this[kVerifyError] = undefined;
      // Node's handle goes with it: no session to ask about from here.
      this._secureEstablished = false;
      this.destroy(err);
      return;
    }
    if (!this.destroyed) this.emit('secureConnect');
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
    if (!kernelTls) throw noTls('tls.connect');
    if (options.path) throw noTls('tls.connect to a Unix socket');
    // Node makes the context first: its checks (and its refusal of key material) come first.
    const context = options.secureContext || createSecureContext(options);
    options.rejectUnauthorized = options.rejectUnauthorized !== false;
    if (options.socket) {
      const socket = new TLSSocket(options.socket, {
        allowHalfOpen: options.allowHalfOpen,
        secureContext: context,
        isServer: false,
        requestCert: true,
        rejectUnauthorized: options.rejectUnauthorized,
        ALPNProtocols: options.ALPNProtocols,
      });
      socket[kConnectOptions] = options;
      if (cb) socket.once('secureConnect', cb);
      socket._start();
      // Node's onConnectSecure, the first 'secure' listener.
      socket.on('secure', onConnectSecure);
      return socket;
    }
    const host = options.host ?? 'localhost';
    const port = Number(options.port ?? 443);
    // The name the kernel checks the certificate against; whether it's sent
    // as the SNI is kernelControlsOf's (Node's rule).
    const servername = options.servername || host;
    const ca = options.ca ? (Array.isArray(options.ca) ? options.ca : [options.ca]) : context?.context?.[kCa];
    const own = clientCredentials(context?.context);
    const socket = new TLSSocket(undefined, { ALPNProtocols: options.ALPNProtocols, allowHalfOpen: options.allowHalfOpen });
    socket._tlsOptions.isServer = false;
    socket[kConnectOptions] = options;
    socket[kStore] = caCertificates(ca);
    socket[kOwnLeaf] = context?.context?.[kOwnCert]?.leaf;
    if (cb) socket.once('secureConnect', cb);
    socket.once('connect', () => {
      process.nextTick(() => {
        if (!socket.destroyed) socket.emit('secure');
      });
    });
    socket.on('secure', onConnectSecure);
    const tls = kernelRequest(options, servername, ca);
    // Where the kernel would take the transport (A1), which has no
    // certificate to show and no protocol but HTTP: its own handshake first,
    // for a host the uplink routes (another port than 443, or a check the
    // transport can't make), then the transport (ENOTSUP: not the uplink's).
    // A client certificate is the kernel's handshake's alone: no transport after it.
    const preferKernel =
      port !== 443 || options.rejectUnauthorized === false || options.checkServerIdentity !== checkServerIdentity || own !== undefined;
    const what = `tls.connect to ${host}:${port}`;
    let keylog = false;
    Reflect.apply(net.Socket.prototype.connect, socket, [
      {
        host,
        port,
        signal: options.signal,
        [kConnectTls]: {
          get tls() {
            keylog = wantsKeylog(socket);
            if (!preferKernel && !keylog) return tls;
            return { ...tls, ...kernelControlsOf(context, options.servername), path: 'kernel', ...(keylog ? { keylog: true } : {}) };
          },
          get retry() {
            return (preferKernel || keylog) && !own ? tls : undefined;
          },
          check: (session) => takeSession(socket, session, options),
          refusedSession: (err) => {
            socket[kVerifyError] = err;
          },
          refused: (err) => refusal(err, { what, options: { ...options, host, port }, ca, own }),
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
