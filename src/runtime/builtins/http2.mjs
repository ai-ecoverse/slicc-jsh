/**
 * node:http2 — Node 22.22.0's export surface, so a package that requires
 * http2 at load and uses it only behind an option (axios, got, the AWS SDK's
 * @smithy/node-http-handler, googleapis, superagent, fastify) loads. Ported
 * from lib/internal/http2/core.js, util.js and compat.js: constants,
 * getDefaultSettings, getPackedSettings / getUnpackedSettings (Node's checks,
 * errors and byte order), sensitiveHeaders, the Http2ServerRequest /
 * Http2ServerResponse classes. There's no HTTP/2 session in jsh yet (h2 needs
 * TLS on ctx.net, h2c a frame layer), so connect, a server's listen and
 * performServerHandshake throw ERR_NOT_SUPPORTED when they are called.
 */
import { ERR_INVALID_ARG_TYPE, nodeError, validateFunction, validateUint32 } from '../node-errors.mjs';
import { HTTP2_CONSTANTS } from './http2-constants.mjs';

function notSupported(what, why) {
  const err = new Error(`slicc-jsh: '${what}' is not supported yet${why ? ` (${why})` : ''}`);
  err.code = 'ERR_NOT_SUPPORTED';
  return err;
}

const kMaxFrameSize = 2 ** 24 - 1;
const kMaxInt = 2 ** 32 - 1;
const kMaxStreams = 2 ** 32 - 1;
const MAX_ADDITIONAL_SETTINGS = 10;

// Setting ids (RFC 9113 6.5.2, RFC 8441), in the order nghttp2 packs them.
const SETTING_IDS = [
  ['headerTableSize', 1],
  ['enablePush', 2],
  ['maxConcurrentStreams', 3],
  ['initialWindowSize', 4],
  ['maxFrameSize', 5],
  ['maxHeaderListSize', 6],
  ['enableConnectProtocol', 8],
];

function settingError(name, actual, min, max) {
  const err = nodeError(
    min === undefined ? TypeError : RangeError,
    'ERR_HTTP2_INVALID_SETTING_VALUE',
    `Invalid value for setting "${name}": ${actual}`
  );
  err.actual = actual;
  if (min !== undefined) {
    err.min = min;
    err.max = max;
  }
  return err;
}

const tooManyCustomSettings = () =>
  nodeError(Error, 'ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS', 'Number of custom settings exceeds MAX_ADDITIONAL_SETTINGS');

function assertIsObject(value, name, types) {
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw ERR_INVALID_ARG_TYPE(name, types || 'Object', value);
  }
}

function assertIsArray(value, name, types) {
  if (value !== undefined && (value === null || !Array.isArray(value))) {
    throw ERR_INVALID_ARG_TYPE(name, types || 'Array', value);
  }
}

function assertWithinRange(name, value, min = 0, max = Infinity) {
  if (value !== undefined && (typeof value !== 'number' || value < min || value > max)) {
    throw settingError(name, value, min, max);
  }
}

function validateSettings(settings) {
  if (settings === undefined) return;
  assertIsObject(settings.customSettings, 'customSettings', 'Number');
  if (settings.customSettings) {
    const entries = Object.entries(settings.customSettings);
    if (entries.length > MAX_ADDITIONAL_SETTINGS) throw tooManyCustomSettings();
    for (const [key, value] of entries) {
      assertWithinRange('customSettings:id', Number(key), 0, 0xffff);
      assertWithinRange('customSettings:value', Number(value), 0, kMaxInt);
    }
  }
  assertWithinRange('headerTableSize', settings.headerTableSize, 0, kMaxInt);
  assertWithinRange('initialWindowSize', settings.initialWindowSize, 0, kMaxInt);
  assertWithinRange('maxFrameSize', settings.maxFrameSize, 16384, kMaxFrameSize);
  assertWithinRange('maxConcurrentStreams', settings.maxConcurrentStreams, 0, kMaxStreams);
  assertWithinRange('maxHeaderListSize', settings.maxHeaderListSize, 0, kMaxInt);
  assertWithinRange('maxHeaderSize', settings.maxHeaderSize, 0, kMaxInt);
  for (const name of ['enablePush', 'enableConnectProtocol']) {
    if (settings[name] !== undefined && typeof settings[name] !== 'boolean') {
      throw settingError(name, settings[name]);
    }
  }
}

export function createHttp2({ process, Buffer, net, tls, getStream }) {
  const constants = {};
  for (const [k, v] of Object.entries(HTTP2_CONSTANTS)) {
    Object.defineProperty(constants, k, { value: v, writable: false, enumerable: true, configurable: false });
  }
  const sensitiveHeaders = Symbol('sensitiveHeaders');

  function getDefaultSettings() {
    return {
      __proto__: null,
      headerTableSize: 4096,
      enablePush: true,
      initialWindowSize: 65535,
      maxFrameSize: 16384,
      maxConcurrentStreams: 4294967295,
      maxHeaderSize: 65535,
      maxHeaderListSize: 65535,
      enableConnectProtocol: false,
    };
  }

  /** util.js updateSettingsBuffer + nghttp2's pack: id order, 6 bytes each. */
  function getPackedSettings(settings) {
    assertIsObject(settings, 'settings');
    validateSettings(settings);
    settings = { ...settings };
    const values = new Map();
    let custom = 0;
    if (typeof settings.customSettings === 'object') {
      for (const setting in settings.customSettings) {
        const val = settings.customSettings[setting];
        if (typeof val !== 'number') continue;
        const id = Number(setting);
        if (Number.isNaN(id) || id <= 0 || id > 0xffff) throw settingError('Range Error', id, 0, 0xffff);
        if (Number.isNaN(val) || val <= 0 || val > 0xffffffff) throw settingError('Range Error', val, 0, 0xffffffff);
        custom++;
        if (custom > MAX_ADDITIONAL_SETTINGS) throw tooManyCustomSettings();
      }
    }
    for (const [name, id] of SETTING_IDS) {
      if (name === 'maxHeaderListSize') {
        if (typeof settings.maxHeaderListSize === 'number' || typeof settings.maxHeaderSize === 'number') {
          if (settings.maxHeaderSize !== undefined && settings.maxHeaderSize !== settings.maxHeaderListSize) {
            process?.emitWarning?.('settings.maxHeaderSize overwrite settings.maxHeaderListSize');
            values.set(id, settings.maxHeaderSize);
          } else values.set(id, settings.maxHeaderListSize);
        }
      } else if (name === 'enablePush' || name === 'enableConnectProtocol') {
        if (typeof settings[name] === 'boolean') values.set(id, Number(settings[name]));
      } else if (typeof settings[name] === 'number') values.set(id, settings[name]);
    }
    // Node 22.22.0's packSettings gives undefined when there are custom settings.
    if (custom > 0) return undefined;
    const buf = Buffer.alloc(values.size * 6);
    let offset = 0;
    for (const [id, value] of values) {
      buf.writeUInt16BE(id, offset);
      buf.writeUInt32BE(value >>> 0, offset + 2);
      offset += 6;
    }
    return buf;
  }

  function getUnpackedSettings(buf, options = {}) {
    if (!ArrayBuffer.isView(buf) || buf.length === undefined) {
      throw ERR_INVALID_ARG_TYPE('buf', ['Buffer', 'TypedArray'], buf);
    }
    if (buf.length % 6 !== 0) {
      throw nodeError(RangeError, 'ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH', 'Packed settings length must be a multiple of six');
    }
    const bytes = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    const settings = {};
    for (let offset = 0; offset < buf.length; offset += 6) {
      const id = bytes.readUInt16BE(offset);
      const value = bytes.readUInt32BE(offset + 2);
      switch (id) {
        case 1:
          settings.headerTableSize = value;
          break;
        case 2:
          settings.enablePush = value !== 0;
          break;
        case 3:
          settings.maxConcurrentStreams = value;
          break;
        case 4:
          settings.initialWindowSize = value;
          break;
        case 5:
          settings.maxFrameSize = value;
          break;
        case 6:
          settings.maxHeaderListSize = settings.maxHeaderSize = value;
          break;
        case 8:
          settings.enableConnectProtocol = value !== 0;
          break;
        default:
          settings.customSettings ||= {};
          settings.customSettings[id] = value;
      }
    }
    if (options != null && options.validate) validateSettings(settings);
    return settings;
  }

  function connect(authority, options, listener) {
    if (typeof options === 'function') {
      listener = options;
      options = undefined;
    }
    void listener;
    assertIsObject(options, 'options');
    options = { ...options };
    assertIsArray(options.remoteCustomSettings, 'options.remoteCustomSettings');
    if (options.remoteCustomSettings?.length > MAX_ADDITIONAL_SETTINGS) throw tooManyCustomSettings();
    if (typeof authority === 'string') authority = new URL(authority);
    assertIsObject(authority, 'authority', ['string', 'Object', 'URL']);
    const protocol = authority.protocol || options.protocol || 'https:';
    if (typeof options.createConnection !== 'function' && protocol !== 'http:' && protocol !== 'https:') {
      throw nodeError(Error, 'ERR_HTTP2_UNSUPPORTED_PROTOCOL', `protocol "${protocol}" is unsupported.`);
    }
    throw notSupported('http2.connect', protocol === 'https:' ? 'no TLS on ctx.net' : 'no HTTP/2 sessions');
  }
  Object.defineProperty(connect, Symbol.for('nodejs.util.promisify.custom'), {
    value: {
      connect(authority, options) {
        return new Promise((resolve, reject) => {
          try {
            connect(authority, options, resolve);
          } catch (err) {
            reject(err);
          }
        });
      },
    }.connect,
  });

  /** core.js initializeOptions: the checks a session's options get (settings are checked later, by the session). */
  function initializeOptions(options) {
    assertIsObject(options, 'options');
    options = { ...options };
    assertIsObject(options.settings, 'options.settings');
    options.settings = { ...options.settings };
    assertIsArray(options.remoteCustomSettings, 'options.remoteCustomSettings');
    if (options.remoteCustomSettings) {
      options.remoteCustomSettings = [...options.remoteCustomSettings];
      if (options.remoteCustomSettings.length > MAX_ADDITIONAL_SETTINGS) throw tooManyCustomSettings();
    }
    for (const name of ['maxSessionInvalidFrames', 'maxSessionRejectedStreams', 'unknownProtocolTimeout']) {
      if (options[name] !== undefined) validateUint32(options[name], name);
    }
    options.unknownProtocolTimeout ??= 10000;
    return options;
  }

  const listenNotSupported = () => notSupported('http2.Server.listen', 'no HTTP/2 sessions');

  class Http2Server extends net.Server {
    constructor(options, requestListener) {
      options = initializeOptions(options);
      super(options);
      this[kOptions] = options;
      this.timeout = 0;
      if (typeof requestListener === 'function') this.on('request', requestListener);
    }
    listen() {
      throw listenNotSupported();
    }
    setTimeout(msecs, callback) {
      this.timeout = msecs;
      if (callback !== undefined) {
        validateFunction(callback, 'callback');
        this.on('timeout', callback);
      }
      return this;
    }
    updateSettings(settings) {
      assertIsObject(settings, 'settings');
      validateSettings(settings);
      this[kOptions].settings = { ...this[kOptions].settings, ...settings };
    }
  }

  class Http2SecureServer extends tls.Server {
    constructor(options, requestListener) {
      // core.js initializeTLSOptions.
      options = initializeOptions(options);
      if (!options.ALPNCallback) {
        options.ALPNProtocols = ['h2'];
        if (options.allowHTTP1 === true) options.ALPNProtocols.push('http/1.1');
      }
      super(options);
      this[kOptions] = options;
      this.timeout = 0;
      if (typeof requestListener === 'function') this.on('request', requestListener);
    }
    listen() {
      throw notSupported('http2.Http2SecureServer.listen', 'no TLS on ctx.net');
    }
    setTimeout(msecs, callback) {
      this.timeout = msecs;
      if (callback !== undefined) {
        validateFunction(callback, 'callback');
        this.on('timeout', callback);
      }
      return this;
    }
    updateSettings(settings) {
      assertIsObject(settings, 'settings');
      validateSettings(settings);
      this[kOptions].settings = { ...this[kOptions].settings, ...settings };
    }
  }

  function createServer(options, handler) {
    if (typeof options === 'function') {
      handler = options;
      options = {};
    }
    return new Http2Server(options, handler);
  }

  function createSecureServer(options, handler) {
    return new Http2SecureServer(options, handler);
  }

  function performServerHandshake(socket, options = {}) {
    void socket;
    initializeOptions(options);
    throw notSupported('http2.performServerHandshake', 'no HTTP/2 sessions');
  }

  // compat.js: the request and response of the compatibility API, over an
  // Http2Stream (which jsh can't make yet; any EventEmitter stands in).
  const stream = getStream();
  class Http2ServerRequest extends stream.Readable {
    constructor(httpStream, headers, options, rawHeaders) {
      super({ autoDestroy: false, ...options });
      this[kState] = { closed: false, didRead: false };
      this[kHeaders] = headers;
      this[kRawHeaders] = rawHeaders;
      this[kTrailers] = {};
      this[kRawTrailers] = [];
      this[kStream] = httpStream;
      this[kAborted] = false;
    }
    get aborted() {
      return this[kAborted];
    }
    get complete() {
      return this[kAborted] || this.readableEnded || this[kState].closed || Boolean(this[kStream]?.destroyed);
    }
    get stream() {
      return this[kStream];
    }
    get headers() {
      return this[kHeaders];
    }
    get rawHeaders() {
      return this[kRawHeaders];
    }
    get trailers() {
      return this[kTrailers];
    }
    get rawTrailers() {
      return this[kRawTrailers];
    }
    get httpVersionMajor() {
      return 2;
    }
    get httpVersionMinor() {
      return 0;
    }
    get httpVersion() {
      return '2.0';
    }
    get method() {
      return this[kHeaders]?.[HTTP2_CONSTANTS.HTTP2_HEADER_METHOD];
    }
    get authority() {
      return this[kHeaders]?.[HTTP2_CONSTANTS.HTTP2_HEADER_AUTHORITY];
    }
    get scheme() {
      return this[kHeaders]?.[HTTP2_CONSTANTS.HTTP2_HEADER_SCHEME];
    }
    get url() {
      return this[kHeaders]?.[HTTP2_CONSTANTS.HTTP2_HEADER_PATH];
    }
    _read() {
      this[kStream]?.resume?.();
    }
  }

  class Http2ServerResponse extends stream {
    constructor(httpStream, options) {
      super(options);
      this[kState] = {
        closed: false,
        ending: false,
        destroyed: false,
        headRequest: false,
        sendDate: true,
        statusCode: HTTP2_CONSTANTS.HTTP_STATUS_OK,
      };
      this[kHeaders] = { __proto__: null };
      this[kTrailers] = { __proto__: null };
      this[kStream] = httpStream;
      this.writable = true;
      this.req = undefined;
    }
    get stream() {
      return this[kStream];
    }
    get statusCode() {
      return this[kState].statusCode;
    }
    get writableEnded() {
      return this[kState].ending;
    }
    get finished() {
      return this[kState].ending;
    }
    getHeader(name) {
      return this[kHeaders][String(name).trim().toLowerCase()];
    }
    getHeaderNames() {
      return Object.keys(this[kHeaders]);
    }
    getHeaders() {
      return { ...this[kHeaders] };
    }
    hasHeader(name) {
      return Object.hasOwn(this[kHeaders], String(name).trim().toLowerCase());
    }
  }

  return {
    connect,
    constants,
    createServer,
    createSecureServer,
    getDefaultSettings,
    getPackedSettings,
    getUnpackedSettings,
    performServerHandshake,
    sensitiveHeaders,
    Http2ServerRequest,
    Http2ServerResponse,
  };
}

const kOptions = Symbol('options');
const kState = Symbol('state');
const kHeaders = Symbol('headers');
const kRawHeaders = Symbol('rawHeaders');
const kTrailers = Symbol('trailers');
const kRawTrailers = Symbol('rawTrailers');
const kStream = Symbol('stream');
const kAborted = Symbol('aborted');
