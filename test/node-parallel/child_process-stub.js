'use strict';
/**
 * Minimal child_process stub so Node's test/common/tmpdir can refresh()
 * without a real spawn (M1 has no child_process).
 */
const fs = require('fs');

function spawnSync(cmd, args = [], opts = {}) {
  // tmpdir refresh: `rm -rf path` via escapePOSIXShell
  const flat = [cmd, ...(Array.isArray(args) ? args : [])].map(String);
  const joined = flat.join(' ');
  const rm = /rm\s+-rf\s+"?([^"]+)"?/.exec(joined);
  if (rm) {
    try {
      fs.rmSync(rm[1], { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* ignore */
    }
    return { status: 0, stdout: '', stderr: '', pid: 0 };
  }
  const err = new Error("slicc-jsh: 'child_process' is not supported yet");
  err.code = 'ERR_NOT_SUPPORTED';
  return { status: 1, stdout: '', stderr: err.message, error: err, pid: 0 };
}

function notSupported() {
  const err = new Error("slicc-jsh: 'child_process' is not supported yet");
  err.code = 'ERR_NOT_SUPPORTED';
  throw err;
}

module.exports = {
  spawnSync,
  spawn: notSupported,
  exec: notSupported,
  execSync: notSupported,
  fork: notSupported,
  execFile: notSupported,
  execFileSync: notSupported,
};
