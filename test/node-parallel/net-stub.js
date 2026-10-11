'use strict';
/** Minimal net stub for Node's test/common on M1 (no real sockets). */
let autoSelectFamilyAttemptTimeout = 250;

function notSupported(name) {
  const err = new Error(`slicc-jsh: net.${name} is not supported yet`);
  err.code = 'ERR_NOT_SUPPORTED';
  throw err;
}

module.exports = {
  createServer: () => notSupported('createServer'),
  createConnection: () => notSupported('createConnection'),
  connect: () => notSupported('connect'),
  isIP: () => 0,
  isIPv4: () => false,
  isIPv6: () => false,
  getDefaultAutoSelectFamilyAttemptTimeout: () => autoSelectFamilyAttemptTimeout,
  setDefaultAutoSelectFamilyAttemptTimeout: (v) => {
    autoSelectFamilyAttemptTimeout = Number(v) || 250;
  },
  getDefaultAutoSelectFamily: () => false,
  setDefaultAutoSelectFamily: () => {},
  Socket: function Socket() {
    notSupported('Socket');
  },
  Server: function Server() {
    notSupported('Server');
  },
};
