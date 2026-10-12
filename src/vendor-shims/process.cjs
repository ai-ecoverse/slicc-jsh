'use strict';
// Alias for npm `process` (readable-stream's `require('process/')`): the
// runtime's own process, whose nextTick is Node's queue (ticks before
// promise jobs, kept alive by the event loop). The npm shim runs ticks
// on a setTimeout queue instead.
module.exports = globalThis.process;
