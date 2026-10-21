/**
 * node:worker_threads' markAsUncloneable, honoured where jsh posts a message
 * (a port's, a worker's and its workerData): a marked object in one is
 * Node's DataCloneError. Node marks its MessageEvents too.
 *
 * The platform's structuredClone is not jsh's: it clones a marked object as
 * any other, as does a BroadcastChannel's post (docs/compatibility.md).
 */
import { isOrdinaryObject } from '../builtins/v8-serdes.mjs';

const marked = new WeakSet();

export const isError = (value) => (Error.isError ? Error.isError(value) : Object.prototype.toString.call(value) === '[object Error]');

/**
 * Node's: any object may be marked, but only an ordinary one (a plain
 * object, a class instance) or an Error is then refused; an array, a Map, a
 * Date or a buffer still goes.
 */
export function markAsUncloneable(value) {
  if (isOrdinaryObject(value) || (value !== null && typeof value === 'object' && isError(value))) marked.add(value);
}

/** One of jsh's own objects Node never clones (a MessageEvent). */
export const markOwnUncloneable = (value) => marked.add(value);

export const isUncloneable = (value) => marked.has(value);

export const uncloneable = () => new DOMException('Cannot clone object of unsupported type.', 'DataCloneError');
