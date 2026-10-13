/**
 * Node 22's internal error codes and validators (lib/internal/errors.js,
 * lib/internal/validators.js), for builtins that port Node's JS layer.
 *
 * nodeError() builds what Node's JS throws: `code` an own enumerable
 * property, the stack's first line `Name [CODE]: message`. nativeError() is
 * what Node's C++ throws: the same `code`, a plain `Name: message` stack.
 */
import { inspect } from 'node-inspect-extracted';

export function nodeError(Base, code, message) {
  const err = new Base(message);
  err.code = code;
  if (typeof err.stack === 'string') {
    const name = err.name;
    const head = `${name}: ${message}`;
    if (err.stack.startsWith(head)) err.stack = `${name} [${code}]: ${message}${err.stack.slice(head.length)}`;
  }
  Object.defineProperty(err, 'toString', {
    value() {
      return `${this.name} [${code}]: ${this.message}`;
    },
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return err;
}

export function nativeError(Base, code, message, extra) {
  const err = new Base(message);
  if (code !== undefined) err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

const classRegExp = /^[A-Z][a-zA-Z0-9]*$/;
const kTypes = ['string', 'function', 'number', 'object', 'Function', 'Object', 'boolean', 'bigint', 'symbol'];

export function formatList(array, type = 'and') {
  switch (array.length) {
    case 0:
      return '';
    case 1:
      return `${array[0]}`;
    case 2:
      return `${array[0]} ${type} ${array[1]}`;
    case 3:
      return `${array[0]}, ${array[1]}, ${type} ${array[2]}`;
    default:
      return `${array.slice(0, -1).join(', ')}, ${type} ${array[array.length - 1]}`;
  }
}

export function determineSpecificType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  switch (typeof value) {
    case 'bigint':
      return `type bigint (${value}n)`;
    case 'number':
      if (value === 0) return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
      if (Number.isNaN(value)) return 'type number (NaN)';
      if (value === Infinity) return 'type number (Infinity)';
      if (value === -Infinity) return 'type number (-Infinity)';
      return `type number (${value})`;
    case 'boolean':
      return value ? 'type boolean (true)' : 'type boolean (false)';
    case 'symbol':
      return `type symbol (${String(value)})`;
    case 'function':
      return `function ${value.name}`;
    case 'object':
      if (value.constructor && 'name' in value.constructor) return `an instance of ${value.constructor.name}`;
      return `${inspect(value, { depth: -1 })}`;
    case 'string': {
      const s = value.length > 28 ? `${value.slice(0, 25)}...` : value;
      return s.indexOf("'") === -1 ? `type string ('${s}')` : `type string (${JSON.stringify(s)})`;
    }
    default:
      return `type ${typeof value} (${inspect(value, { colors: false })})`;
  }
}

export function invalidArgTypeMessage(name, expected, actual) {
  if (!Array.isArray(expected)) expected = [expected];
  let msg = 'The ';
  if (name.endsWith(' argument')) msg += `${name} `;
  else msg += `"${name}" ${name.includes('.') ? 'property' : 'argument'} `;
  msg += 'must be ';
  const types = [];
  const instances = [];
  const other = [];
  for (const value of expected) {
    if (kTypes.includes(value)) types.push(value.toLowerCase());
    else if (classRegExp.test(value)) instances.push(value);
    else other.push(value);
  }
  if (instances.length > 0) {
    const pos = types.indexOf('object');
    if (pos !== -1) {
      types.splice(pos, 1);
      instances.push('Object');
    }
  }
  if (types.length > 0) {
    msg += `${types.length > 1 ? 'one of type' : 'of type'} ${formatList(types, 'or')}`;
    if (instances.length > 0 || other.length > 0) msg += ' or ';
  }
  if (instances.length > 0) {
    msg += `an instance of ${formatList(instances, 'or')}`;
    if (other.length > 0) msg += ' or ';
  }
  if (other.length > 0) {
    if (other.length > 1) msg += `one of ${formatList(other, 'or')}`;
    else {
      if (other[0].toLowerCase() !== other[0]) msg += 'an ';
      msg += `${other[0]}`;
    }
  }
  return `${msg}. Received ${determineSpecificType(actual)}`;
}

export const ERR_INVALID_ARG_TYPE = (name, expected, actual) =>
  nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', invalidArgTypeMessage(name, expected, actual));

export function ERR_INVALID_ARG_VALUE(name, value, reason = 'is invalid', Base = TypeError) {
  let inspected = inspect(value);
  if (inspected.length > 128) inspected = `${inspected.slice(0, 128)}...`;
  const type = name.includes('.') ? 'property' : 'argument';
  return nodeError(Base, 'ERR_INVALID_ARG_VALUE', `The ${type} '${name}' ${reason}. Received ${inspected}`);
}

function addNumericalSeparator(val) {
  let res = '';
  let i = val.length;
  const start = val[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) res = `_${val.slice(i - 3, i)}${res}`;
  return `${val.slice(0, i)}${res}`;
}

export function ERR_OUT_OF_RANGE(str, range, input, replaceDefaultBoolean = false) {
  let msg = replaceDefaultBoolean ? str : `The value of "${str}" is out of range.`;
  let received;
  if (Number.isInteger(input) && Math.abs(input) > 2 ** 32) received = addNumericalSeparator(String(input));
  else if (typeof input === 'bigint') {
    received = String(input);
    if (input > 2n ** 32n || input < -(2n ** 32n)) received = addNumericalSeparator(received);
    received += 'n';
  } else received = inspect(input);
  msg += ` It must be ${range}. Received ${received}`;
  return nodeError(RangeError, 'ERR_OUT_OF_RANGE', msg);
}

// --- lib/internal/validators.js ---

export function validateString(value, name) {
  if (typeof value !== 'string') throw ERR_INVALID_ARG_TYPE(name, 'string', value);
}

export function validateNumber(value, name, min = undefined, max) {
  if (typeof value !== 'number') throw ERR_INVALID_ARG_TYPE(name, 'number', value);
  if (
    (min != null && value < min) ||
    (max != null && value > max) ||
    ((min != null || max != null) && Number.isNaN(value))
  ) {
    throw ERR_OUT_OF_RANGE(
      name,
      `${min != null ? `>= ${min}` : ''}${min != null && max != null ? ' && ' : ''}${max != null ? `<= ${max}` : ''}`,
      value
    );
  }
}

export function validateInteger(value, name, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number') throw ERR_INVALID_ARG_TYPE(name, 'number', value);
  if (!Number.isInteger(value)) throw ERR_OUT_OF_RANGE(name, 'an integer', value);
  if (value < min || value > max) throw ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
}

export function validateInt32(value, name, min = -2147483648, max = 2147483647) {
  if (typeof value !== 'number') throw ERR_INVALID_ARG_TYPE(name, 'number', value);
  if (!Number.isInteger(value)) throw ERR_OUT_OF_RANGE(name, 'an integer', value);
  if (value < min || value > max) throw ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
}

export function validateUint32(value, name, positive = false) {
  if (typeof value !== 'number') throw ERR_INVALID_ARG_TYPE(name, 'number', value);
  if (!Number.isInteger(value)) throw ERR_OUT_OF_RANGE(name, 'an integer', value);
  const min = positive ? 1 : 0;
  const max = 4_294_967_295;
  if (value < min || value > max) throw ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
}

export function validateFunction(value, name) {
  if (typeof value !== 'function') throw ERR_INVALID_ARG_TYPE(name, 'Function', value);
}

export function validateBoolean(value, name) {
  if (typeof value !== 'boolean') throw ERR_INVALID_ARG_TYPE(name, 'boolean', value);
}

// validateObject's options (lib/internal/validators.js).
export const kValidateObjectAllowNullable = 1;
export const kValidateObjectAllowArray = 2;
export const kValidateObjectAllowFunction = 4;

export function validateObject(value, name, options = 0) {
  if (options === 0) {
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
      throw ERR_INVALID_ARG_TYPE(name, 'Object', value);
    }
    return;
  }
  if ((options & kValidateObjectAllowNullable) === 0 && value === null) throw ERR_INVALID_ARG_TYPE(name, 'Object', value);
  if ((options & kValidateObjectAllowArray) === 0 && Array.isArray(value)) throw ERR_INVALID_ARG_TYPE(name, 'Object', value);
  const t = typeof value;
  if (!(t === 'object' || ((options & kValidateObjectAllowFunction) !== 0 && t === 'function'))) {
    throw ERR_INVALID_ARG_TYPE(name, 'Object', value);
  }
}

/** internal/util normalizeEncoding: undefined for an unknown encoding. */
export function normalizeEncoding(enc) {
  if (enc == null || enc === 'utf8' || enc === 'utf-8') return 'utf8';
  switch (String(enc).toLowerCase()) {
    case 'utf8':
    case 'utf-8':
      return 'utf8';
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return 'utf16le';
    case 'latin1':
    case 'binary':
      return 'latin1';
    case 'base64':
      return 'base64';
    case 'base64url':
      return 'base64url';
    case 'hex':
      return 'hex';
    case 'ascii':
      return 'ascii';
    case '':
      return 'utf8';
    default:
      return undefined;
  }
}

export function validateEncoding(data, encoding) {
  const normalizedEncoding = normalizeEncoding(encoding);
  const length = data.length;
  if (normalizedEncoding === 'hex' && length % 2 !== 0) {
    throw ERR_INVALID_ARG_VALUE('encoding', encoding, `is invalid for data of length ${length}`);
  }
}

export const ERR_INVALID_CURSOR_POS = () =>
  nodeError(TypeError, 'ERR_INVALID_CURSOR_POS', 'Cannot set cursor row without setting its column');

export const ERR_USE_AFTER_CLOSE = (name = 'Object') => nodeError(Error, 'ERR_USE_AFTER_CLOSE', `${name} was closed`);

/** internal/errors AbortError. */
export class AbortError extends Error {
  constructor(message = 'The operation was aborted', options = undefined) {
    super(message, options);
    this.code = 'ABORT_ERR';
    this.name = 'AbortError';
  }
}

/**
 * internal/errors' `codes` for Node lib files: each a constructor (`new
 * ERR_X(...)`, as they call them) that builds the error above.
 */
/** Node's SystemError (internal/errors.js): `prefix: syscall returned CODE (message) path => dest`. */
export function systemError(key, prefix, context = {}) {
  let message = `${prefix}: ${context.syscall} returned ${context.code} (${context.message})`;
  if (context.path !== undefined) message += ` ${context.path}`;
  if (context.dest !== undefined) message += ` => ${context.dest}`;
  const err = new Error(message);
  Object.defineProperty(err, 'name', { value: 'SystemError', enumerable: false, writable: true, configurable: true });
  err.stack = `SystemError [${key}]: ${message}${err.stack.slice(err.stack.indexOf('\n'))}`;
  err.code = key;
  Object.defineProperty(err, 'info', { value: context, enumerable: true, configurable: true, writable: false });
  Object.defineProperty(err, 'errno', { get: () => context.errno, set: (v) => (context.errno = v), enumerable: true, configurable: true });
  Object.defineProperty(err, 'syscall', { get: () => context.syscall, set: (v) => (context.syscall = v), enumerable: true, configurable: true });
  return err;
}

export function ERR_INVALID_URL_SCHEME(expected) {
  if (typeof expected === 'string') expected = [expected];
  const res = expected.length === 2 ? `one of scheme ${expected[0]} or ${expected[1]}` : `of scheme ${expected[0]}`;
  return nodeError(TypeError, 'ERR_INVALID_URL_SCHEME', `The URL must be ${res}`);
}

export function ERR_MISSING_ARGS(...args) {
  const len = args.length;
  const wrap = (a) => `"${a}"`;
  const names = args.map((a) => (Array.isArray(a) ? a.map(wrap).join(' or ') : wrap(a)));
  return nodeError(TypeError, 'ERR_MISSING_ARGS', `The ${formatList(names)} argument${len > 1 ? 's' : ''} must be specified`);
}

export function errorCodes() {
  const factories = {
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_OUT_OF_RANGE,
    ERR_INVALID_CURSOR_POS,
    ERR_USE_AFTER_CLOSE,
    ERR_INVALID_THIS: (type) => nodeError(TypeError, 'ERR_INVALID_THIS', `Value of "this" must be of type ${type}`),
    ERR_UNHANDLED_ERROR: (err = undefined) =>
      nodeError(Error, 'ERR_UNHANDLED_ERROR', err === undefined ? 'Unhandled error.' : `Unhandled error. (${err})`),
    ERR_INVALID_URI: () => nodeError(URIError, 'ERR_INVALID_URI', 'URI malformed'),
    ERR_INVALID_URL: (input, base = null) =>
      Object.assign(nodeError(TypeError, 'ERR_INVALID_URL', 'Invalid URL'), { input }, base != null ? { base } : {}),
    ERR_INVALID_URL_SCHEME: (expected) => ERR_INVALID_URL_SCHEME(expected),
    ERR_INVALID_FILE_URL_HOST: (platform) =>
      nodeError(TypeError, 'ERR_INVALID_FILE_URL_HOST', `File URL host must be "localhost" or empty on ${platform}`),
    ERR_INVALID_FILE_URL_PATH: (reason, input) =>
      Object.assign(nodeError(TypeError, 'ERR_INVALID_FILE_URL_PATH', `File URL path ${reason}`), { input }),
    ERR_MISSING_ARGS: (...args) => ERR_MISSING_ARGS(...args),
    ERR_SYSTEM_ERROR: (ctx) => systemError('ERR_SYSTEM_ERROR', 'A system error occurred', ctx),
    ERR_ASYNC_TYPE: (type) => nodeError(TypeError, 'ERR_ASYNC_TYPE', `Invalid name for async "type": ${type}`),
    ERR_INVALID_ASYNC_ID: (type, id) => nodeError(RangeError, 'ERR_INVALID_ASYNC_ID', `Invalid ${type} value: ${id}`),
    ERR_CONSOLE_WRITABLE_STREAM: (name) =>
      nodeError(TypeError, 'ERR_CONSOLE_WRITABLE_STREAM', `Console expects a writable stream instance for ${name}`),
    ERR_FALSY_VALUE_REJECTION: (reason) =>
      Object.assign(nodeError(Error, 'ERR_FALSY_VALUE_REJECTION', 'Promise was rejected with falsy value'), { reason }),
    ERR_INCOMPATIBLE_OPTION_PAIR: (a, b) =>
      nodeError(TypeError, 'ERR_INCOMPATIBLE_OPTION_PAIR', `Option "${a}" cannot be used in combination with option "${b}"`),
    ERR_INVALID_MIME_SYNTAX: (production, str, invalidIndex) =>
      nodeError(
        TypeError,
        'ERR_INVALID_MIME_SYNTAX',
        `The MIME syntax for a ${production} in "${str}" is invalid${invalidIndex !== -1 ? ` at ${invalidIndex}` : ''}`
      ),
    ERR_PARSE_ARGS_INVALID_OPTION_VALUE: (msg) => nodeError(TypeError, 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE', msg),
    ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL: (arg) =>
      nodeError(
        TypeError,
        'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL',
        `Unexpected argument '${arg}'. This command does not take positional arguments`
      ),
    ERR_PARSE_ARGS_UNKNOWN_OPTION: (option, allowPositionals) =>
      nodeError(
        TypeError,
        'ERR_PARSE_ARGS_UNKNOWN_OPTION',
        `Unknown option '${option}'${
          allowPositionals
            ? `. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- ${JSON.stringify(option)}`
            : ''
        }`
      ),
    // The REPL's and domain's (lib/repl.js, lib/domain.js).
    ERR_CANNOT_WATCH_SIGINT: () => nodeError(Error, 'ERR_CANNOT_WATCH_SIGINT', 'Cannot watch for SIGINT signals'),
    ERR_DOMAIN_CALLBACK_NOT_AVAILABLE: () =>
      nodeError(
        Error,
        'ERR_DOMAIN_CALLBACK_NOT_AVAILABLE',
        'A callback was registered through process.setUncaughtExceptionCaptureCallback(), which is mutually exclusive with using the `domain` module'
      ),
    ERR_DOMAIN_CANNOT_SET_UNCAUGHT_EXCEPTION_CAPTURE: () =>
      nodeError(
        Error,
        'ERR_DOMAIN_CANNOT_SET_UNCAUGHT_EXCEPTION_CAPTURE',
        'The `domain` module is in use, which is mutually exclusive with calling process.setUncaughtExceptionCaptureCallback()'
      ),
    ERR_INSPECTOR_NOT_AVAILABLE: () => nodeError(Error, 'ERR_INSPECTOR_NOT_AVAILABLE', 'Inspector is not available'),
    ERR_INVALID_REPL_EVAL_CONFIG: () =>
      nodeError(TypeError, 'ERR_INVALID_REPL_EVAL_CONFIG', 'Cannot specify both "breakEvalOnSigint" and "eval" for REPL'),
    ERR_INVALID_REPL_INPUT: (msg) => nodeError(TypeError, 'ERR_INVALID_REPL_INPUT', String(msg)),
    ERR_SCRIPT_EXECUTION_INTERRUPTED: () =>
      nodeError(Error, 'ERR_SCRIPT_EXECUTION_INTERRUPTED', 'Script execution was interrupted by `SIGINT`'),
  };
  const codes = {};
  for (const [name, make] of Object.entries(factories)) {
    // A plain function (constructible): `new ERR_X()` returns the error made.
    const ctor = function (...args) {
      return make(...args);
    };
    Object.defineProperty(ctor, 'name', { value: name });
    // Node's codes have a HideStackFramesError twin (for hideStackFrames()).
    ctor.HideStackFramesError = ctor;
    codes[name] = ctor;
  }
  return codes;
}

export function validateAbortSignal(signal, name) {
  if (signal !== undefined && (signal === null || typeof signal !== 'object' || !('aborted' in signal))) {
    throw ERR_INVALID_ARG_TYPE(name, 'AbortSignal', signal);
  }
}

export function validateStringArray(value, name) {
  validateArray(value, name);
  for (let i = 0; i < value.length; ++i) {
    if (typeof value[i] !== 'string') throw ERR_INVALID_ARG_TYPE(`${name}[${i}]`, 'string', value[i]);
  }
}

export function validateBooleanArray(value, name) {
  validateArray(value, name);
  for (let i = 0; i < value.length; ++i) {
    if (value[i] !== true && value[i] !== false) throw ERR_INVALID_ARG_TYPE(`${name}[${i}]`, 'boolean', value[i]);
  }
}

export function validateUnion(value, name, union) {
  if (!union.includes(value)) throw ERR_INVALID_ARG_TYPE(name, `('${union.join('|')}')`, value);
}

export function validateArray(value, name, minLength = 0) {
  if (!Array.isArray(value)) throw ERR_INVALID_ARG_TYPE(name, 'Array', value);
  if (value.length < minLength) {
    throw ERR_INVALID_ARG_VALUE(name, value, `must be longer than ${minLength}`);
  }
}

export function validateOneOf(value, name, oneOf) {
  if (!oneOf.includes(value)) {
    const allowed = oneOf.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(', ');
    throw ERR_INVALID_ARG_VALUE(name, value, `must be one of: ${allowed}`);
  }
}

/** internal/errors ErrnoException / ExceptionWithHostPort (util._errnoException, …). */
export function makeErrnoClasses(getSystemErrorName) {
  class ErrnoException extends Error {
    constructor(err, syscall, original) {
      const code = getSystemErrorName(err);
      super(original ? `${syscall} ${code} ${original}` : `${syscall} ${code}`);
      this.errno = err;
      this.code = code;
      this.syscall = syscall;
    }
    get ['constructor']() {
      return Error;
    }
  }
  class ExceptionWithHostPort extends Error {
    constructor(err, syscall, address, port, additional) {
      const code = getSystemErrorName(err);
      let details = '';
      if (port && port > 0) details = ` ${address}:${port}`;
      else if (address) details = ` ${address}`;
      if (additional) details += ` - Local (${additional})`;
      super(`${syscall} ${code}${details}`);
      this.errno = err;
      this.code = code;
      this.syscall = syscall;
      this.address = address;
      if (port) this.port = port;
    }
    get ['constructor']() {
      return Error;
    }
  }
  return { ErrnoException, ExceptionWithHostPort };
}
