/** Thrown by `process.exit` to unwind user code; caught by the node entry. */
export class NodeExitError extends Error {
  constructor(code) {
    super(`Process exited with code ${code}`);
    this.name = 'NodeExitError';
    this.code = code;
    this.status = code;
  }
}

/** True for what `process.exit` throws (ours, or the kernel's `JsExit` it reuses). */
export function isExitError(err) {
  return err instanceof NodeExitError || err?.name === 'NodeExitError' || err?.name === 'JsExit';
}

/**
 * End the program now. `ctx.exit` tells the kernel the status at once (the
 * kernel then ends the process as soon as this turn unwinds, whatever the
 * script's promises do) and throws the kernel's `JsExit` to unwind. That
 * error is what we throw: the kernel recognises it, so nothing reports it as
 * an error. Without `ctx.exit` (an old kernel) a NodeExitError unwinds.
 */
export function hardExitError(ctx, code) {
  if (typeof ctx?.exit === 'function') {
    try {
      ctx.exit(code);
    } catch (err) {
      if (err && typeof err === 'object' && err.name === 'JsExit') {
        try {
          Object.defineProperty(err, 'name', { value: 'NodeExitError', configurable: true, writable: true });
          err.message = `Process exited with code ${code}`;
          err.code = code;
        } catch {
          /* frozen: keep the kernel's */
        }
        return err;
      }
    }
  }
  return new NodeExitError(code);
}

export function numericExitCode(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n & 0xff : 0;
}

function describeReceived(value) {
  if (typeof value === 'string') return `type string ('${value}')`;
  if (typeof value === 'boolean') return `type boolean (${value})`;
  if (typeof value === 'bigint') return `type bigint (${value}n)`;
  if (Array.isArray(value)) return 'an instance of Array';
  if (typeof value === 'object' && value !== null) return 'an instance of Object';
  return `type ${typeof value}`;
}

export function assignProcessExitCode(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const n = Number(value);
    if (value !== '' && Number.isInteger(n)) return n === 0 ? 0 : n;
    const err = new TypeError(
      `The "code" argument must be of type number. Received ${describeReceived(value)}`
    );
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value === 0 ? 0 : value;
    const err = new RangeError(
      `The value of "code" is out of range. It must be an integer. Received ${String(value)}`
    );
    err.code = 'ERR_OUT_OF_RANGE';
    throw err;
  }
  const err = new TypeError(
    `The "code" argument must be of type number. Received ${describeReceived(value)}`
  );
  err.code = 'ERR_INVALID_ARG_TYPE';
  throw err;
}
