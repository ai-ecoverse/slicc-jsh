# Node's own lib files

`lib/` holds files from Node.js v22.22.0's `lib/` (https://github.com/nodejs/node/tree/v22.22.0/lib), unchanged. They are under Node's MIT license (see NOTICE).

`scripts/build.mjs` bundles them from `entry.cjs` into `dist/vendor/node-lib.cjs`, which the runtime evaluates on first use (`src/runtime/node-lib.mjs`):

- their free `primordials` is `primordials.cjs`, which makes Node's primordials on demand from their names;
- a `require('internal/…')` of a file in `lib/` is bundled; any other `require` is left to the runtime, which hands in its own `internal/errors`, `internal/validators`, `os`, … .

To update, copy the files from the new Node tag and re-run the goldens.

| file | used by |
|---|---|
| `lib/internal/tty.js` | `tty.WriteStream#getColorDepth` / `hasColors` |
| `lib/internal/readline/callbacks.js` | `tty.WriteStream#cursorTo` / `moveCursor` / `clearLine` / `clearScreenDown` |
| `lib/internal/readline/utils.js` | `CSI` for the above |
| `lib/internal/process/warning.js` | `process.emitWarning` and the default `'warning'` listener |
