/**
 * What Node's lib/url.js needs from `internal/url` and the `url` /
 * `encoding_binding` bindings (src/node-lib/lib/url.js runs as it is): the
 * platform's WHATWG URL, and Node 22.22.0's fileURLToPath / pathToFileURL /
 * urlToHttpOptions / domainTo* (ported from lib/internal/url.js; ada's IDNA is
 * the URL parser's, punycode decoding RFC 3492's).
 */
import { encodeFilePath } from './url.mjs';
import {
  ERR_INVALID_ARG_TYPE,
  ERR_INVALID_ARG_VALUE,
  ERR_INVALID_URL_SCHEME,
  ERR_MISSING_ARGS,
  nodeError,
  validateObject,
} from '../node-errors.mjs';

const isURL = (self) => Boolean(self?.href && self.protocol && self.auth === undefined && self.path === undefined);

const unsafeProtocol = new Set(['javascript', 'javascript:']);
const hostlessProtocol = new Set(['javascript', 'javascript:']);
const slashedProtocol = new Set([
  'http', 'http:', 'https', 'https:', 'ftp', 'ftp:', 'gopher', 'gopher:', 'file', 'file:', 'ws', 'ws:', 'wss', 'wss:',
]);

/**
 * Node's domainToASCII (node_url.cc): a URL's hostname setter given the
 * domain (it stops at '/', '?', '#'; a port, credentials or a bad host make
 * it fail, leaving the host as it was), '' when that fails.
 */
const SENTINEL = 'slicc-jsh-domain-sentinel.invalid';
function toASCII(domain) {
  domain = `${domain}`;
  if (domain === '') return '';
  const u = new URL(`ws://${SENTINEL}/`);
  u.hostname = domain;
  if (u.hostname === SENTINEL && domain.toLowerCase() !== SENTINEL) return '';
  return u.hostname;
}

// RFC 3492 decoding (Bootstring for IDNA).
function punycodeDecode(input) {
  const base = 36;
  const tMin = 1;
  const tMax = 26;
  const adapt = (delta, numPoints, firstTime) => {
    let k = 0;
    delta = firstTime ? Math.floor(delta / 700) : delta >> 1;
    delta += Math.floor(delta / numPoints);
    for (; delta > ((base - tMin) * tMax) >> 1; k += base) delta = Math.floor(delta / (base - tMin));
    return Math.floor(k + ((base - tMin + 1) * delta) / (delta + 38));
  };
  const digit = (c) => (c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : base);
  const output = [];
  let basic = input.lastIndexOf('-');
  if (basic < 0) basic = 0;
  for (let j = 0; j < basic; j++) {
    if (input.charCodeAt(j) >= 0x80) throw new RangeError('not-basic');
    output.push(input.charCodeAt(j));
  }
  let i = 0;
  let n = 128;
  let bias = 72;
  for (let index = basic > 0 ? basic + 1 : 0; index < input.length; ) {
    const oldi = i;
    for (let w = 1, k = base; ; k += base) {
      if (index >= input.length) throw new RangeError('invalid-input');
      const d = digit(input.charCodeAt(index++));
      if (d >= base) throw new RangeError('invalid-input');
      i += d * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (d < t) break;
      w *= base - t;
    }
    const out = output.length + 1;
    bias = adapt(i - oldi, out, oldi === 0);
    n += Math.floor(i / out);
    i %= out;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}

function domainToASCII(domain) {
  if (arguments.length < 1) throw ERR_MISSING_ARGS('domain');
  return toASCII(domain);
}

function domainToUnicode(domain) {
  if (arguments.length < 1) throw ERR_MISSING_ARGS('domain');
  const ascii = toASCII(domain);
  if (ascii === '') return '';
  try {
    return ascii
      .split('.')
      .map((label) => (label.startsWith('xn--') ? punycodeDecode(label.slice(4)) : label))
      .join('.');
  } catch {
    return '';
  }
}

function urlToHttpOptions(url) {
  validateObject(url, 'url');
  const { hostname, pathname, port, username, password, search } = url;
  const options = {
    __proto__: null,
    ...url,
    protocol: url.protocol,
    hostname: hostname && hostname[0] === '[' ? hostname.slice(1, -1) : hostname,
    hash: url.hash,
    search,
    pathname,
    path: `${pathname || ''}${search || ''}`,
    href: url.href,
  };
  if (port !== '') options.port = Number(port);
  if (username || password) options.auth = `${decodeURIComponent(username)}:${decodeURIComponent(password)}`;
  return options;
}

const invalidHost = () =>
  nodeError(TypeError, 'ERR_INVALID_FILE_URL_HOST', 'File URL host must be "localhost" or empty on linux');
const invalidPath = (reason, input) =>
  Object.assign(nodeError(TypeError, 'ERR_INVALID_FILE_URL_PATH', `File URL path ${reason}`), { input });

function getPathFromURLPosix(url) {
  if (url.hostname !== '') throw invalidHost();
  const pathname = url.pathname;
  for (let n = 0; n < pathname.length; n++) {
    if (pathname[n] === '%') {
      const third = pathname.codePointAt(n + 2) | 0x20;
      if (pathname[n + 1] === '2' && third === 102) throw invalidPath('must not include encoded / characters', url);
    }
  }
  return decodeURIComponent(pathname);
}

function getPathFromURLWin32(url) {
  const hostname = url.hostname;
  let pathname = url.pathname;
  for (let n = 0; n < pathname.length; n++) {
    if (pathname[n] === '%') {
      const third = pathname.codePointAt(n + 2) | 0x20;
      if ((pathname[n + 1] === '2' && third === 102) || (pathname[n + 1] === '5' && third === 99)) {
        throw invalidPath('must not include encoded \\ or / characters', url);
      }
    }
  }
  pathname = decodeURIComponent(pathname.replace(/\//g, '\\'));
  if (hostname !== '') return `\\\\${domainToUnicode(hostname)}${pathname}`;
  const letter = pathname.codePointAt(1) | 0x20;
  if (letter < 97 || letter > 122 || pathname[2] !== ':') throw invalidPath('must be absolute', url);
  return pathname.slice(1);
}

function percentDecodeBytes(str) {
  const bytes = new TextEncoder().encode(str);
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    const hex = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
    if (bytes[i] === 37 && hex(bytes[i + 1]) && hex(bytes[i + 2])) {
      out.push(parseInt(String.fromCharCode(bytes[i + 1], bytes[i + 2]), 16));
      i += 2;
    } else out.push(bytes[i]);
  }
  return Uint8Array.from(out);
}

export function createUrlInternals({ nodePath, Buffer }) {
  function fileURLToPath(path, options) {
    const windows = options?.windows;
    if (typeof path === 'string') path = new URL(path);
    else if (!isURL(path)) throw ERR_INVALID_ARG_TYPE('path', ['string', 'URL'], path);
    if (path.protocol !== 'file:') throw ERR_INVALID_URL_SCHEME('file');
    return windows ? getPathFromURLWin32(path) : getPathFromURLPosix(path);
  }

  function fileURLToPathBuffer(path, options) {
    const windows = options?.windows;
    if (typeof path === 'string') path = new URL(path);
    else if (!isURL(path)) throw ERR_INVALID_ARG_TYPE('path', ['string', 'URL'], path);
    if (path.protocol !== 'file:') throw ERR_INVALID_URL_SCHEME('file');
    if (windows) return Buffer.from(getPathFromURLWin32(path));
    if (path.hostname !== '') throw invalidHost();
    return Buffer.from(percentDecodeBytes(path.pathname));
  }

  function pathToFileURL(filepath, options) {
    const windows = options?.windows ?? false;
    if (windows) {
      // \\?\C:\… (a local extended path) is the drive path.
      if (/^\\\\\?\\[A-Za-z]:/.test(filepath)) filepath = filepath.slice(4);
      if (filepath.startsWith('\\\\')) {
        const extended = filepath.startsWith('\\\\?\\UNC\\');
        const prefix = extended ? 8 : 2;
        const end = filepath.indexOf('\\', prefix);
        if (end === -1) throw ERR_INVALID_ARG_VALUE('path', filepath, 'Missing UNC resource path');
        if (end === 2) throw ERR_INVALID_ARG_VALUE('path', filepath, 'Empty UNC servername');
        const host = filepath.slice(prefix, end);
        return new URL(`file://${host}${encodeFilePath(filepath.slice(end).replace(/\\/g, '/'))}`);
      }
      let resolved = nodePath.win32.resolve(filepath);
      const last = filepath.charCodeAt(filepath.length - 1);
      if ((last === 47 || last === 92) && !resolved.endsWith('\\')) resolved += '\\';
      return new URL(`file:///${encodeFilePath(resolved.replace(/\\/g, '/'))}`);
    }
    let resolved = nodePath.posix.resolve(filepath);
    // path.resolve strips trailing slashes; Node puts them back.
    if (filepath.charCodeAt(filepath.length - 1) === 47 && !resolved.endsWith('/')) resolved += '/';
    return new URL(`file://${encodeFilePath(resolved)}`);
  }

  return {
    URL: globalThis.URL,
    // Node's URLParse: a URL, or null when it doesn't parse.
    URLParse: (input, base) => {
      try {
        return new globalThis.URL(input, base);
      } catch {
        return null;
      }
    },
    URLSearchParams: globalThis.URLSearchParams,
    isURL,
    domainToASCII,
    domainToUnicode,
    fileURLToPath,
    fileURLToPathBuffer,
    pathToFileURL,
    toPathIfFileURL: (fileURLOrPath) => (isURL(fileURLOrPath) ? fileURLToPath(fileURLOrPath) : fileURLOrPath),
    urlToHttpOptions,
    unsafeProtocol,
    hostlessProtocol,
    slashedProtocol,
  };
}

/** internalBinding('url') / ('encoding_binding') for lib/url.js. */
export const urlBindings = {
  url: {
    domainToASCII: (d) => toASCII(d),
    domainToUnicode: (d) => domainToUnicode(d),
    /** url.format(URL, { fragment, unicode, search, auth }). */
    format(href, fragment, unicode, search, auth) {
      const u = new URL(href);
      if (!fragment) u.hash = '';
      if (!search) u.search = '';
      if (!auth) {
        u.username = '';
        u.password = '';
      }
      let out = u.href;
      if (!fragment && out.endsWith('#')) out = out.slice(0, -1);
      if (unicode && u.hostname) {
        const uni = domainToUnicode(u.hostname);
        if (uni && uni !== u.hostname) out = out.replace(u.hostname, uni);
      }
      return out;
    },
  },
  encoding_binding: { toASCII },
};
