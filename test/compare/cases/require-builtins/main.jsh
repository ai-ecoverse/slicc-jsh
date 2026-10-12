const names = ['assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'dns/promises', 'domain', 'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'path/posix', 'path/win32', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'readline/promises', 'repl', 'stream', 'stream/consumers', 'stream/promises', 'stream/web', 'string_decoder', 'sys', 'timers', 'timers/promises', 'tls', 'trace_events', 'tty', 'url', 'util', 'util/types', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib'];
for (const n of names) {
  let r;
  try {
    const m = require(n);
    let same;
    try { same = require('node:' + n) === m ? 'same' : 'differs'; } catch (e) { same = 'node: throws'; }
    r = `${typeof m} ${same}`;
  } catch (e) {
    r = `THROW ${e.code || e.name}: ${String(e.message).split('\n')[0].slice(0, 90)}`;
  }
  console.log(`${n}: ${r}`);
}
