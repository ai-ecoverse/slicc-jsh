'use strict';
/** Minimal worker_threads stub for Node's test/common on M1. */
module.exports = {
  isMainThread: true,
  parentPort: null,
  workerData: null,
  threadId: 0,
  Worker: function Worker() {
    const err = new Error("slicc-jsh: 'worker_threads' is not supported yet");
    err.code = 'ERR_NOT_SUPPORTED';
    throw err;
  },
};
