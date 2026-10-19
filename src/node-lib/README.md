# Node's own lib files

`lib/` holds files from Node.js v22.22.0's `lib/` (https://github.com/nodejs/node/tree/v22.22.0/lib), unchanged. They are under Node's MIT license (see NOTICE).

`scripts/build.mjs` bundles them from `entry.cjs` into `dist/vendor/node-lib.cjs`, which the runtime evaluates once, at start (`src/runtime/node-lib.mjs`; `events` is needed from the first line):

- their free `primordials` is `primordials.cjs`, which makes Node's primordials on demand from their names;
- a `require('internal/…')` of a file in `lib/` is bundled; any other `require` is left to the runtime, which hands in its own `internal/errors`, `internal/validators`, `os`, … .

To update, copy the files from the new Node tag and re-run the goldens.

| file | used by |
|---|---|
| `lib/events.js`, `lib/internal/events/{abort_listener,symbols}.js`, `lib/internal/fixed_queue.js` | `require('events')`, and every EventEmitter in the runtime (`process` included) |
| `lib/internal/tty.js` | `tty.WriteStream#getColorDepth` / `hasColors` |
| `lib/internal/readline/callbacks.js` | `tty.WriteStream#cursorTo` / `moveCursor` / `clearLine` / `clearScreenDown` |
| `lib/internal/readline/utils.js` | `CSI` for the above |
| `lib/readline.js`, `lib/readline/promises.js`, `lib/internal/readline/{interface,emitKeypressEvents,promises}.js` | `require('readline')`, `require('readline/promises')` |
| `lib/internal/process/warning.js` | `process.emitWarning` and the default `'warning'` listener |
| `lib/internal/process/finalization.js` | `process.finalization` |
| `lib/internal/source_map/{source_map,source_map_cache,source_map_cache_map,prepare_stack_trace}.js` | source maps: `--enable-source-maps`, `process.setSourceMapsEnabled`, `module.findSourceMap` / `SourceMap` / `get`/`setSourceMapsSupport`, stacks and uncaught reports |
| `lib/repl.js`, `lib/internal/repl.js`, `lib/internal/repl/{utils,history,await}.js`, `lib/domain.js` | the REPL (`node` with no script on a terminal, or `-i`), `require('repl')`, `require('domain')` |
| `lib/sys.js`, `lib/diagnostics_channel.js`, `lib/stream/consumers.js` | `require('sys')`, `require('diagnostics_channel')` (and the console's channels), `require('stream/consumers')` |
| `lib/wasi.js` | `require('wasi')`, on `internalBinding('wasi')` from `src/runtime/wasi-binding.mjs` (the kernel's `ctx.sync.wasi.create`) |
