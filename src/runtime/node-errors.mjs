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

export function validateObject(value, name) {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
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
  };
  const codes = {};
  for (const [name, make] of Object.entries(factories)) {
    // A plain function (constructible): `new ERR_X()` returns the error made.
    const ctor = function (...args) {
      return make(...args);
    };
    Object.defineProperty(ctor, 'name', { value: name });
    codes[name] = ctor;
  }
  return codes;
}

export function validateAbortSignal(signal, name) {
  if (signal !== undefined && (signal === null || typeof signal !== 'object' || !('aborted' in signal))) {
    throw ERR_INVALID_ARG_TYPE(name, 'AbortSignal', signal);
  }
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
