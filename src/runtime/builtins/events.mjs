/**
 * events: Node v22.22.0's own lib/events.js (src/node-lib), so every
 * EventEmitter in the runtime — process, streams' owners, child processes,
 * servers — is Node's: newListener/removeListener, prependListener,
 * errorMonitor, captureRejections, setMaxListeners and its leak warning,
 * events.once/on with AbortSignal, getEventListeners, listenerCount, ….
 */
import { loadNodeLib } from '../node-lib.mjs';

export const EventEmitter = loadNodeLib().events;

/** require('events'): the EventEmitter constructor with the module's helpers on it. */
export function createEvents() {
  return EventEmitter;
}
