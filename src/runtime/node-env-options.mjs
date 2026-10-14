/**
 * Node 22.22.0's options NODE_OPTIONS may carry (kAllowedInEnvvar), by kind,
 * and their aliases, from its option table
 * (require('internal/options').getCLIOptionsInfo(), recorded from node
 * 22.22.0). Booleans also take their `--no-` form.
 */
/** Options that take a value (`--x=v` or `--x v`). */
export const ENV_VALUED = new Set([
  '--allow-fs-read', '--allow-fs-write', '--conditions', '--cpu-prof-dir', '--cpu-prof-interval', '--cpu-prof-name',
  '--diagnostic-dir', '--disable-proto', '--disable-warning', '--dns-result-order', '--experimental-default-type',
  '--experimental-loader', '--heap-prof-dir', '--heap-prof-interval', '--heap-prof-name',
  '--heapsnapshot-near-heap-limit', '--heapsnapshot-signal', '--icu-data-dir', '--import', '--input-type',
  '--inspect-port', '--inspect-publish-uid', '--localstorage-file', '--max-http-header-size',
  '--max-old-space-size-percentage', '--network-family-autoselection-attempt-timeout', '--openssl-config',
  '--redirect-warnings', '--report-dir', '--report-filename', '--report-signal', '--require', '--secure-heap',
  '--secure-heap-min', '--snapshot-blob', '--stack-trace-limit', '--test-coverage-branches',
  '--test-coverage-exclude', '--test-coverage-functions', '--test-coverage-include', '--test-coverage-lines',
  '--test-name-pattern', '--test-reporter', '--test-reporter-destination', '--test-shard', '--test-skip-pattern',
  '--title', '--tls-cipher-list', '--tls-keylog', '--trace-event-categories', '--trace-event-file-pattern',
  '--trace-require-module', '--unhandled-rejections', '--use-largepages', '--v8-pool-size', '--watch-kill-signal',
  '--watch-path',
]);
/** Boolean options. */
export const ENV_BOOLEAN = new Set([
  '--addons', '--allow-addons', '--allow-child-process', '--allow-wasi', '--allow-worker', '--cpu-prof',
  '--debug-arraybuffer-allocations', '--deprecation', '--disable-sigusr1', '--disable-wasm-trap-handler',
  '--enable-fips', '--enable-source-maps', '--entry-url', '--experimental-addon-modules',
  '--experimental-async-context-frame', '--experimental-detect-module', '--experimental-eventsource',
  '--experimental-fetch', '--experimental-global-customevent', '--experimental-global-navigator',
  '--experimental-global-webcrypto', '--experimental-import-meta-resolve', '--experimental-print-required-tla',
  '--experimental-repl-await', '--experimental-require-module', '--experimental-shadow-realm',
  '--experimental-sqlite', '--experimental-strip-types', '--experimental-transform-types',
  '--experimental-vm-modules', '--experimental-websocket', '--experimental-webstorage',
  '--extra-info-on-fatal-exception', '--force-async-hooks-checks', '--force-context-aware', '--force-fips',
  '--force-node-api-uncaught-exceptions-policy', '--frozen-intrinsics', '--global-search-paths', '--heap-prof',
  '--insecure-http-parser', '--inspect', '--inspect-brk', '--inspect-wait', '--network-family-autoselection',
  '--node-snapshot', '--openssl-legacy-provider', '--openssl-shared-config', '--pending-deprecation', '--permission',
  '--preserve-symlinks', '--preserve-symlinks-main', '--report-compact', '--report-exclude-env',
  '--report-exclude-network', '--report-on-fatalerror', '--report-on-signal', '--report-uncaught-exception',
  '--test-only', '--throw-deprecation', '--tls-max-v1.2', '--tls-max-v1.3', '--tls-min-v1.0', '--tls-min-v1.1',
  '--tls-min-v1.2', '--tls-min-v1.3', '--trace-atomics-wait', '--trace-deprecation', '--trace-env',
  '--trace-env-js-stack', '--trace-env-native-stack', '--trace-exit', '--trace-promises', '--trace-sigint',
  '--trace-sync-io', '--trace-tls', '--trace-uncaught', '--trace-warnings', '--track-heap-objects',
  '--use-bundled-ca', '--use-env-proxy', '--use-openssl-ca', '--use-system-ca', '--verify-base-objects',
  '--warnings', '--watch', '--watch-preserve-output', '--zero-fill-buffers',
]);
/** V8's options Node passes on (`--x=v` only). */
export const ENV_V8 = new Set([
  '--abort-on-uncaught-exception', '--disallow-code-generation-from-strings', '--enable-etw-stack-walking',
  '--expose-gc', '--huge-max-old-generation-size', '--interpreted-frames-native-stack', '--jitless',
  '--max-old-space-size', '--max-semi-space-size', '--perf-basic-prof', '--perf-basic-prof-only-functions',
  '--perf-prof', '--perf-prof-unwinding-info',
]);
/** Accepted and ignored. */
export const ENV_NOOP = new Set([
  '--experimental-abortcontroller', '--experimental-json-modules', '--experimental-modules', '--experimental-report',
  '--experimental-specifier-resolution', '--experimental-top-level-await', '--experimental-wasi-unstable-preview1',
  '--experimental-wasm-modules', '--experimental-worker', '--http-parser', '--napi-modules', '--node-memory-debug',
]);
/** Aliases (`-r` → `--require`), as Node's table has them. */
export const ENV_ALIASES = {
  '--debug-port': [
    '--inspect-port'
  ],
  '-r': [
    '--require'
  ],
  '-p': [
    '--print'
  ],
  '--loader': [
    '--experimental-loader'
  ],
  '-pe': [
    '--print',
    '--eval'
  ],
  '--inspect-brk-node=': [
    '--inspect-port',
    '--inspect-brk-node'
  ],
  '--inspect=': [
    '--inspect-port',
    '--inspect'
  ],
  '--print <arg>': [
    '-pe'
  ],
  '-c': [
    '--check'
  ],
  '--inspect-wait=': [
    '--inspect-port',
    '--inspect-wait'
  ],
  '--debug-brk=': [
    '--debug-brk'
  ],
  '--prof-process': [
    '--prof-process',
    '--'
  ],
  '-e': [
    '--eval'
  ],
  '--es-module-specifier-resolution': [
    '--experimental-specifier-resolution'
  ],
  '-C': [
    '--conditions'
  ],
  '-v': [
    '--version'
  ],
  '--enable-network-family-autoselection': [
    '--network-family-autoselection'
  ],
  '--inspect-brk=': [
    '--inspect-port',
    '--inspect-brk'
  ],
  '--debug=': [
    '--debug'
  ],
  '--report-directory': [
    '--report-dir'
  ],
  '--experimental-permission': [
    '--permission'
  ],
  '-h': [
    '--help'
  ],
  '-i': [
    '--interactive'
  ],
  '--security-reverts': [
    '--security-revert'
  ],
  '--trace-events-enabled': [
    '--trace-event-categories',
    'v8,node,node.async_hooks'
  ]
};
