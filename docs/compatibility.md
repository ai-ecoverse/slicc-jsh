# Node compatibility

slicc-jsh's `node` targets Node v22.22.0. This page lists, module by module, what works, what differs from Node and what isn't there. The [README](../README.md#node-compatibility) has the one-table summary, and [Kernel requirements](../README.md#kernel-requirements) lists the features that need a newer slicc-kernel than 1.53.2.

Where a module is Node's own code, the file is carried unchanged from Node v22.22.0's `lib/` in [`src/node-lib`](../src/node-lib/README.md). What those files ask of Node's C++ comes from `src/runtime/node-bindings.mjs`. The other bundled libraries are pinned in `package.json`; [NOTICE](../NOTICE) lists every one.

The goldens named below are fixtures in `test/golden/fixtures/`, checked byte for byte against Node 22.22.0.

- [The `node` command](#the-node-command)
- [Modules and ESM](#modules-and-esm)
- [`process` and the end of a program](#process-and-the-end-of-a-program)
- [stdio, `tty` and signals](#stdio-tty-and-signals)
- [Warnings](#warnings)
- [`fs`](#fs)
- [`child_process`](#child_process)
- [`net`, `http` and `https`](#net-http-and-https)
- [`tls`](#tls)
- [`http2`](#http2)
- [`dns`](#dns)
- [`fetch` and `WebSocket`](#fetch-and-websocket)
- [`crypto`](#crypto)
- [`zlib`](#zlib)
- [Streams and `Buffer`](#streams-and-buffer)
- [`events`](#events)
- [`readline` and the REPL](#readline-and-the-repl)
- [`util`, `console`, `os`, `path`, `url`, `querystring`, `punycode`](#util-console-os-path-url-querystring-punycode)
- [`vm`](#vm)
- [`async_hooks`, `domain`, `perf_hooks`, `v8` and diagnostics](#async_hooks-domain-perf_hooks-v8-and-diagnostics)
- [Modules that are not available](#modules-that-are-not-available)

## The `node` command

- `node script.js`, `node -e`, `node -p`, `node -pe`, `node -` (the program from stdin, even a terminal), and `node` with no script (the [REPL](#readline-and-the-repl) on a terminal, else the piped text as a script). `-i` forces the REPL.
- `-r X` / `--require X` loads `X` first, from the working directory. Its require stack is `internal/preload`.
- `--import X` loads the ES module `X` after the `-r` modules and before the entry, top-level `await` included.
- `--input-type=module|commonjs` for `-e` and piped input. `--input-type=module-typescript` and `commonjs-typescript` fail: there's no TypeScript.
- `--stack-trace-limit=N` sets `Error.stackTraceLimit`.
- `--max-old-space-size=N`, `--trace-uncaught` and `--trace-sigint` are accepted. The kernel sets a program's memory, the uncaught report is the usual one, and no stack is printed on SIGINT.
- A bad value for a V8 flag gets V8's report, followed by Node's `bad option` lines.
- V8's flags take one dash as well as two (`-stack-trace-limit=5`); Node's own options need two. `-e` and `-p` take their code as the next argument, so `-econsole.log(1)` is a `bad option`, as in Node (golden `cli-single-dash-node22`).
- Options after `-e`/`-p` are still node's, up to the first argument.
- `-p` (`--print`) is a boolean, as in Node: its code is the next argument only if that is there, not empty and doesn't start with `-`. So `node -p` alone prints what stdin evaluates to (`undefined` for none), and `node -p -1` is a `bad option`. `--print=X` and `--no-print` are the same option, and `-e` after `-p` still prints (golden `cli-print-node22`).
- `--` ends the options: the next argument is the script (`-` or an empty one reads stdin).
- `-e` and `-p` run their code as a script, as Node's `evalScript` does: `require`, `module`, `exports`, `__filename` and `__dirname` are set on `globalThis`, `var` declares a global, and a top-level `return` is a SyntaxError. On the Node host it runs as a classic script in the program's global scope, as Node's `vm.runInThisContext` does, through the kernel's `ctx.sync.runScript` (slicc-kernel 1.157.0, ai-ecoverse/slicc-kernel#1541): `let`, `const` and `class` are in the global lexical scope, where a later indirect `eval` sees them, and `var` is on the global in strict-mode code too. `import()` still works. So does piped stdin, as `[stdin]`, and a Worker's `eval` code (golden `eval-script-scope-node22`). Code whose top-level `let`, `const` or `class` takes the name of a global, such as `const { setTimeout } = require('timers/promises')`, runs with an indirect `eval` instead: the kernel's own code looks those names up in the program's global scope, and a global binding would replace them there (golden `eval-shadow-globals-node22`). That waits on ai-ecoverse/slicc-kernel#1586. jsh's own code and its vendored builtins never look a global up by name: the build turns each such lookup into a property read on the global object it captured at load. In a browser the kernel has no such script, and jsh runs the code with an indirect `eval`: its `let`, `const` and `class` stay in the code's own scope, and so does `var` in strict-mode code. `-p` prints the completion value (`node -p 'const a = 1; a'` prints `1`) from an `'exit'` listener, so the code's own timers and exit listeners come first (golden `cli-print-completion-node22`). A printed promise shows its state, as in Node (`node -p 'Promise.resolve(1)'` prints `Promise { 1 }`; see `util.inspect`).
- `NODE_OPTIONS` is read as Node 22 reads it: words with spaces, quotes and escapes; only the options Node allows there; its options before the command line's and out of `execArgv`; Node's errors.
- Boolean options take `--x` and `--no-x`, and the last form wins. A value that looks like an option counts as missing (`--require --no-warnings`).
- Also: the [warning flags](#warnings), `--enable-source-maps`, `--preserve-symlinks`, `--preserve-symlinks-main`, `--expose-internals`, `--title`, `--pending-deprecation` and the `--report-*` options (they set `process.report`).
- `-c`/`--check` checks the script's syntax and runs nothing, as Node's `check_syntax` does. A file is checked as the module it is: ES module by extension, `"type"`, or detection. Piped input is checked as CommonJS unless `--input-type=module`. A SyntaxError gets the usual report under the script's real path, with exit status 1. Combined with `-e`/`-p`, it's an error (status 9).
- `--watch`, `--watch-path`, `--watch-preserve-output` and `--watch-kill-signal` are Node's watch mode, its own `lib/internal/main/watch_mode.js` (golden `watch-mode-node22`). It needs a kernel with an IPC channel for the child ([slicc-kernel#1093](https://github.com/ai-ecoverse/slicc-kernel/issues/1093)) and `fs.watch`.
  - The program runs in a child. Each module the child requires or imports goes to the watch process over IPC, and when one of them changes the child is restarted. With `--watch-path`, a change anywhere in the given trees restarts it. SIGTERM or SIGINT ends the watch and the child.
  - Node's errors apply: `--watch requires specifying a file`, and `--watch` with `-e`/`-p`, `--check` or `-i`.
  - As on Linux, a relative `require` that wasn't found is reported, but its appearing doesn't restart the child: the watcher can't watch a file that isn't there.
- Any other option, such as `--inspect` or `--experimental-strip-types`, is `bad option` (status 9).

## Modules and ESM

**CommonJS.** `require` resolves as Node does: `node_modules`, `package.json` `"exports"` and `"imports"`, `node:` builtins, JSON. `require('.')` and `require('..')` are paths, and a request that ends in `/`, `/.` or `/..` names a directory, never the file beside it (golden `require-dot`). The module wrapper is Node's five-argument form. `process`, `Buffer` and the timers are real globals. The platform's newer V8 builtins that Node 22.22.0's V8 lacks, `Float16Array`, `Math.f16round` and `DataView`'s `getFloat16` and `setFloat16`, are taken out while a program runs, so a program that looks for them takes Node 22's path (golden `float16-absent-node22`). Modules resolve through symlinks to their real path, unless `--preserve-symlinks` (or `--preserve-symlinks-main`). `module.createRequire`, `Module._extensions`, `Module.builtinModules` and `isBuiltin` are there.

**ESM.** `.mjs`, `"type": "module"`, static `import`/`export`, dynamic `import()`, `import.meta.url`, `import.meta.resolve`, `import.meta.dirname` and `import.meta.filename`, and JSON with `with { type: 'json' }`. The resolver, its errors and its stack frames are Node 22's. The transform uses acorn, so multi-line imports and exports, strings, comments and `$` identifiers parse correctly. Imports are hoisted, and export getters are registered before evaluation, so cycles work. `-e` and ambiguous `.js` files are detected as Node does; a dynamic `import()` alone stays CommonJS.

**Compiling a module.** On the Node host, a CommonJS or ES module file's code is compiled as a classic script, through the kernel's `ctx.sync.runScript`, as Node compiles its modules. So V8 gives the eval code it runs a position in its eval origin, as in Node: `eval at f (/a.js:2:3)`, and an ES module's names its `file:` URL. An uncaught error in that code prints Node's `<anonymous_script>:N` header with the eval'd line and its caret (golden `eval-code-files-uncaught-node22`). In a browser the kernel has no such script, so a module's code is a `Function` body, and V8 names only the file in such an origin (`eval at f (/a.js)`), with no header.

**Interop.**
- `import` of CommonJS: the named exports are what Node's cjs-module-lexer finds in the source, re-exports included. The default export is `module.exports` itself, never its `.default`.
- `require()` of an ES module with a default export returns Node's facade with `__esModule: true` and live bindings, or its `'module.exports'` export.
- `package.json` `"exports"` with `import`/`require` conditions.
- `import()` inside `new Function` and `AsyncFunction` bodies loads through the runtime, resolved against the calling script. jsh wraps the Function constructors for that, but a function they make still has V8's frames, with its eval origin at the caller's call, as in Node: `at eval (eval at f ([eval]:1:23), <anonymous>:3:13)`. An uncaught error in one prints the `<anonymous_script>:N` header, its body a string or not. An indirect eval keeps its native `at eval (<anonymous>)` frame (golden `function-eval-frames-node22`).

**ES module input.** With `--input-type=module`, the program is `<cwd>/[eval1]`, as in Node (`import.meta.url`, `filename`, `dirname`). Its `import.meta.resolve` gives a missing file's URL rather than throwing.

**Export conditions.** In the kernel, `require` resolves with `['slicc', 'require', 'node', 'default']` and `import` with `['slicc', 'import', 'node', 'default']`. Host Node never sets `slicc`, so a package can ship separate code for slicc-kernel.

**Source maps**, as Node 22's own `lib/internal/source_map`: `--enable-source-maps`, `process.setSourceMapsEnabled`, `module.findSourceMap`, `SourceMap`, `getSourceMapsSupport` and `setSourceMapsSupport`. Stacks and uncaught reports go through them.

**Stacks.** Frames name a module by its URL (query and fragment included) and count a CommonJS file's hashbang line, as Node's do. Timer callbacks' stacks keep the script's URL.

**`--expose-internals`** makes the internal modules carried in `src/node-lib` requirable (for Node's own tests).

**Not available:** `module.register`, `module.registerHooks`, `syncBuiltinESMExports`, `findPackageJSON`, `enableCompileCache`, `stripTypeScriptTypes`, native addons (`.node`), and TypeScript.

## `process` and the end of a program

**Exit.**
- `process.exit()` ends the program at once. That includes `cli.die`, `cli.help` and a fatal `kill(self)`. It goes through `ctx.sync.exit`, so no `catch`, `finally`, microtask or timer of the program runs after it, as in Node.
- `'exit'` listeners run first on every way out: the end of the loop, `process.exit()`, an uncaught error and an unhandled rejection. The `process.exitCode` they leave is the status. On an uncaught error they run before its report, and a `process.exit()` in one ends the program without the report.
- An unhandled rejection is raised as an uncaught exception first, as with Node's default `--unhandled-rejections=throw`. An `'uncaughtException'` listener (origin `'unhandledRejection'`) or the capture callback can take it. A reason that isn't error-like comes wrapped in an `UnhandledPromiseRejection`.
- Ticks queued by a timer, an immediate or the main script run before that callback's promise jobs. After a tick's uncaught exception is handled, the rest of the queue runs first too.
- So do ticks queued by the callback of an event from the kernel, as Node's `MakeCallback` runs them: an `fs` callback, a child's `'exit'` and its stdout and stderr `'data'`, a server's `'connection'`, and a socket's `'connect'` and `'close'` (golden `callback-scope-order-node22`). A promise continuation keeps its promise jobs first, as in Node.
- Platform work in flight keeps the program alive until it settles, as Node's pending I/O does: WebCrypto (`crypto.subtle`), WebAssembly compilation, and, where the browser has WebGPU, `requestAdapter`, `requestDevice`, `mapAsync`, `onSubmittedWorkDone`, `createComputePipelineAsync`, `createRenderPipelineAsync`, `popErrorScope` and `getCompilationInfo`. `GPUDevice.lost` doesn't: it stays pending for the device's whole life.

**Signals and `kill`.**
- `process.kill(process.pid, sig)` delivers to `process.on(sig)` listeners on a later turn. Like Node's signal handles, they don't keep the program alive. With no listener, the program dies of the signal at once: status 128 + n, no `'exit'`. Its argument errors (`ESRCH`, `EINVAL`, `ERR_UNKNOWN_SIGNAL`) are Node's.
- `process.kill(process.pid | 0 | -pgid, sig)` and `process.abort()` end the program inside the call, through `ctx.sync.kill`, and `kill` reaches other processes.
- SIGPIPE is ignored from the start, as in Node, so a write to a pipe whose reader is gone fails with `EPIPE`. stdout and stderr are never really destroyed (Node's `dummyDestroy`): every failed write emits `'error'` again. `console` swallows only the first one, so a program that keeps logging to a dead pipe ends with status 1, as Node's does. Removing the last `'SIGPIPE'` listener brings back the default action (death by the signal, 141).

**Other members.**
- `process.chdir` throws Node's `ENOENT`/`ENOTDIR` errors. `process.ppid` comes from the kernel: on each read from `/proc` (1 once the parent has ended). As in Node, an assignment to it changes nothing. It is an accessor property: Node's is a V8 native data property, which reports a writable `value` yet ignores writes, and plain JavaScript can't make one; a data property would let an assignment stick.
- `process.env` stores strings, as Node's does.
- `process.umask()` and `process.umask(mask)` work on the kernel's umask (`ctx.sync.umask`). A child inherits it, and the kernel applies it to what the program creates. Arguments are parsed as Node's are. As in Node 22, calling it with no argument prints no warning (DEP0139 is documentation-only there).
- `process.getuid`, `getgid` and the like read the kernel's credentials. `process.setuid`, `setgid`, `seteuid`, `setegid`, `setgroups` and `initgroups` follow Node on Linux.
- `process.memoryUsage()` has Node's keys, all numbers. Each one is either measured or `0`, which means nothing here can measure it, the way Node's `os.loadavg()` is `[0, 0, 0]` on Windows. jsh never estimates a field. A process worker has no heap statistics in either host: the Node host's lockdown takes `process` and `node:v8`, and Chromium's `performance.memory` exists only on the window. So the fields come from the kernel's `ctx.memory()` where a kernel has it (ai-ecoverse/slicc-kernel#1240; it's feature-detected), and otherwise:
  - `rss`: on the Node host, the host process's resident set size (slicc-kernel 1.158.0, ai-ecoverse/slicc-kernel#1563). That's what a Node worker thread reports, so it isn't this program's own: every kernel process and thread of that host shares it. In a browser it's `0`, because a browser can't know it. `process.memoryUsage.rss()` returns the same value.
  - `heapTotal` and `heapUsed`: `0`, both together, unless the program runs where `performance.memory` exists. When they are measured, `heapUsed` ≤ `heapTotal`.
  - `arrayBuffers`: the bytes of the live ArrayBuffers that this program's Buffers allocated (`alloc`, `allocUnsafe`, the copies `from` and `concat` make). The count drops once the garbage collector frees them. Views on existing memory (`subarray`, `Buffer.from(arrayBuffer)`) add nothing. Buffers under 4 KiB aren't counted either, because tracking each one would slow down allocation-heavy code. A plain `new Uint8Array(n)` and WebAssembly memory aren't Buffers, so jsh doesn't see them, and the figure is a lower bound of Node's.
  - `external`: `arrayBuffers`, which Node's `external` includes. It's a lower bound for the same reason.
- `process.versions` lists what the runtime has or mirrors: `brotli` and `zstd` (their decoders and encoders: `got` then asks for `br` and `zstd`), no openssl, ….
- `argv0`, `pid`, `version`, `versions`, `arch`, `platform`, `release`, `config` and `features` are read-only, as in Node. `argv[0]` is `execPath`.
- `process.report` is Node's API (`getReport`, `writeReport`, the `--report-*` options). It writes on an uncaught exception and on its signal, as Node does. Its header has Linux's fields.
- `process.execve` runs the command to its end on this program's stdio, and the program then ends as the command did (its status, or the signal it died of), with no `'exit'` event. It needs slicc-kernel 1.65.0.
- `process.loadEnvFile`, `process.finalization`, `process.emitWarning` (see [Warnings](#warnings)), and the rest of Node 22's members (`binding`, `dlopen`, `allowedNodeEnvironmentFlags`, `_getActiveHandles`, …).

## stdio, `tty` and signals

`process.stdin`, `process.stdout` and `process.stderr` are Node's streams, made on first access: a `stream.Readable` and two `stream.Writable`s. `pipe`, `stream.pipeline`, async iteration, `'data'`/`'end'`, `setEncoding` and `pause`/`resume` work.

- **On a terminal** they're `tty.ReadStream` and `tty.WriteStream`:
  - `isTTY`;
  - `setRawMode` (the kernel's raw mode, put back when the program ends);
  - `columns`/`rows`, with `'resize'` on `SIGWINCH`;
  - `getColorDepth`/`hasColors` (Node's own `internal/tty.js`);
  - `cursorTo`/`moveCursor`/`clearLine`/`clearScreenDown`.
- **Off a terminal** they have no `isTTY`, as in Node.
- **Paused stdin.** Reading stdin keeps the program alive only while something consumes it, so a paused stdin lets the program end.
- **`tty.isatty(fd)`** answers for fds 0–2, which the runtime asks the kernel about before the program starts. Any other fd is `false`.
- **Signal listeners.** A `process.on('SIGINT' | 'SIGTERM' | 'SIGWINCH' | …)` listener installs a kernel signal handler. Removing the last listener puts the default action back. `SIGKILL`/`SIGSTOP` throw `uv_signal_start EINVAL`.
- **Timing.** The kernel installs a handler a moment after `process.on` returns; Node does it synchronously. `setRawMode` likewise takes effect a moment after it returns, so a key typed in between is still echoed.

## Warnings

`process.emitWarning` is Node's own `internal/process/warning.js`. It prints `(node:PID) [CODE] Name: message`, the first time with its `--trace-…` hint, and emits `'warning'`. `util.deprecate` warns once per code, as Node's does. `--no-warnings`, `--no-deprecation`, `--trace-warnings`, `--trace-deprecation`, `--throw-deprecation`, `--disable-warning=CODE`, `--redirect-warnings=FILE` and `NODE_NO_WARNINGS=1` work as in Node.

## `fs`

The sync forms run on the kernel's synchronous calls, the callback and promise forms on its async ones. Pending async calls keep the program alive.

**Paths.** Every path argument may be a string, a `Buffer` (or `Uint8Array`) or a `file:` URL (`fs.writeFileSync(new URL('./x', import.meta.url))`), in the sync, callback, promise and stream forms, and in `watch`, `cp`, `rm`, `mkdtemp` and `realpath` (golden `fs-path-forms-node22`). `fs.promises.readFile`, `writeFile` and `appendFile` take a `FileHandle` too.
- As in Node 22, a `Buffer` path comes back as one where Node keeps it: a `Dirent`'s `parentPath`, a `Dir`'s `path` and a stream's `path`. `encoding: 'buffer'` makes `readdir`, `readlink`, `realpath` and `mkdtemp` return `Buffer`s. Errors name the path as a string.
- Bad paths get Node's errors. Another type is `ERR_INVALID_ARG_TYPE`, and a NUL byte is `ERR_INVALID_ARG_VALUE`. A URL with another scheme is `ERR_INVALID_URL_SCHEME`, one with a host is `ERR_INVALID_FILE_URL_HOST`, and one with an encoded `/` is `ERR_INVALID_FILE_URL_PATH`. Node 22's own quirks are kept: `realpath` and `realpathSync` turn a non-string into a string first, and `promises.readlink` calls its argument `oldPath`.
- `cp`'s callback and promise forms and recursive `readdir` throw in Node 22 for a `Buffer` path, but work in jsh. `watchFile` and `unwatchFile` refuse a `Buffer`, with Node 22's `ERR_INVALID_ARG_TYPE`.

**Constants.** `fs.constants` is Node 22's set for Linux x86_64, in Node's order, and numeric `open` flags are read by those bits. `require('constants')` (deprecated in Node) is `os`'s dlopen, errno, priority and signals constants plus `fs`'s and `crypto`'s, frozen.

**Symlinks and `cp`.** `cp`, `cpSync` and `promises.cp` follow Node 22.22's own code, quirks included (goldens `fs-cp-sync`, `fs-cp-async`, `fs-readdir-links`):
- A symlink in a copied tree stays a symlink, with its target made absolute unless `verbatimSymlinks`. A linked directory is never descended into.
- `cpSync(src, dest, { recursive: true, dereference: true })` still copies a tree's symlinks as symlinks. That is Node 22.22's native `CpSyncCopyDir`. Only `fs.cp`/`promises.cp` (Node's `cp.js`) really dereference.
- `readdirSync({ recursive })` and `promises.readdir({ recursive })` with names descend into linked directories. `promises.readdir` with `withFileTypes` and `opendir({ recursive })` don't.
- `realpathSync` resolves every link.
- `linkSync` is the kernel's: it works on `tmpfs`, and fails with `EPERM` on the root file system and `fsa`, and with `EXDEV` across mounts.

**`statfs`.** `statfs`, `statfsSync` and `promises.statfs` return a `StatFs`. It is the kernel's storage estimate in 4 KiB blocks, reported as tmpfs: its quota and usage. The browser's storage has no inodes, so `files`/`ffree` follow the blocks.

**`/dev`.** Devices (`/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/stdout`, `/dev/fd/N`, …) open as kernel descriptors and are read and written as streams, never whole. A link to a device is followed first. `/dev/stdin` and `/dev/fd/0` are `process.stdin`.

**Descriptors.** A descriptor open for writing holds the file it opened, as on Linux: once that file is unlinked, renamed away, or replaced by another renamed over its path, `writeSync`, `fs.write`, `ftruncate`, appends, write streams and a `FileHandle`'s `write`, `truncate`, `writeFile` and `appendFile` still go to it, and never to the file now at the path (golden `fs-fd-holds-its-file-node22`). A `FileHandle`'s `writeFile` and `appendFile` write at its position, as Node's do. A child given such a file as its stdout or stderr writes to it too, after the parent has closed its descriptor (golden `child-process-fd-held-node22`). Each write is synced, so it is one `'change'`. Where the kernel can't open the file for the descriptor, with an error other than a refusal, the descriptor writes by its path.

**Modes.** `chmod`, `fchmod` (and `FileHandle.chmod`, both by the descriptor's path) change the mode in the kernel:
- They follow a symlink, and only the permission bits count (`mode & 0o7777`, as Linux masks the rest).
- Only the file's owner or root may change a mode: anyone else gets `EPERM`, with Node's error (`code`, `syscall` `chmod`, `path`).
- Arguments are parsed as Node 22 parses them: octal strings such as `'755'`, `ERR_INVALID_ARG_VALUE`/`TYPE`, `ERR_OUT_OF_RANGE`.
- A script a program writes and `chmod`s `0o755` runs by path: spawn, `#!`, binfmt, the shell.

**Owners and times.** `chown`, `lchown`, `fchown`, `utimes`, `lutimes` and `futimes` check their arguments and that the path (or fd) exists, as Node's do, and change nothing, on every kernel: the kernel's JS file system has no call for them. `fs.lchmod` and `lchmodSync` are keys whose value is `undefined`, as in Node on Linux, and `promises.lchmod` rejects with `ERR_METHOD_NOT_IMPLEMENTED`.

**Arguments first.** As in Node, fs checks its arguments before it touches the file system: open's flags, the data of `writeFile`/`appendFile`, and every `mode`. A path with a NUL byte is `ERR_INVALID_ARG_VALUE` (`existsSync` says `false`).

**New files' modes.** A file or directory fs creates gets the mode it asked for, less `process.umask()`, as in Node. The kernel creates it with that mode, so there's never a moment with another:
- `writeFile`, `appendFile`, `open`, `FileHandle`s and `createWriteStream`: `mode`, default `0o666`;
- `mkdir`, recursive included: `mode`, default `0o777`;
- `mkdtemp`: `0o700`.

An existing file keeps its mode. `copyFile` gives the copy the source's mode, whether the copy is new or replaces a file, as libuv does. `cp` copies files the same way; the directories it makes get the default mode.

**`mkdir`** without `recursive` is the kernel's exclusive mkdir. It gives `EEXIST` for an existing name and `ENOENT` for a missing parent (`ENOTDIR` under a file), and of two processes making one name, exactly one succeeds, so a directory works as a lock. That holds among the processes of one kernel, not between two kernels on one origin, such as two tabs ([slicc-kernel#519](https://github.com/ai-ecoverse/slicc-kernel/issues/519)). `recursive: true` works as in Node, returning the first directory it made.

**`rm` with `recursive`.** `rm`, `rmSync`, `promises.rm` and recursive `rmdir` validate their options as Node does, and `force` forgives a missing path only. They run Node 22's rimraf step for step on the kernel's calls, so what is removed, what is left and the error are Node's:
- `rmSync` `rmdir`s a directory first, and empties it only when that says `ENOTEMPTY`, `EEXIST` or `EPERM`. Any other error stops it where it is. A tree with a `0555` subdirectory fails on that subdirectory's own `rmdir` (`EACCES: permission denied, rmdir 't6/a/b/c'`) and keeps everything, and `rmSync('/dev', { recursive: true })` as a user fails on `rmdir '/dev'`.
- `rm` and `promises.rm` work through a directory's entries side by side, so the entries beside the one refused still go. Node's thread pool may report either of two refusals that come back together. jsh's steps run in the order they're issued, so the one it reports is fixed.
- `rmdir(2)` of a directory with entries checks the parent's permission first, as Linux does.

`/dev` entries can't be removed: `unlink`, `rm` and `rmSync` of them give `EACCES` for a user and `EPERM` for root, from the kernel.

**`watchFile` and `unwatchFile`** poll `stat`, as Node's do (libuv's `uv_fs_poll`). They see a change made by any process in the kernel, or by the embedder (goldens `fs-watchfile-node22` and `fs-watchfile-unref-node22`):
- The poll stats at the start and then every `interval` ms (default 5007). A listener gets `(curr, prev)` Stats when the times, size, mode, owner, inode or device differ from the last poll. With `bigint: true` the Stats are bigint ones.
- A missing file gives Stats with every field 0 (dates at the epoch). As in Node, the listener is called once with those at the start, again when the file appears, and again when it goes.
- Listeners on one path share one `StatWatcher`, which every call returns. `unwatchFile(path, listener)` removes one listener, and `unwatchFile(path)` removes them all. The watcher stops when none is left, and emits `'stop'`.
- `persistent: false`, or `unref()` on the returned watcher, lets the program end while it watches. `ref()` and `unref()` count per listener, as Node 22 counts them. `stop()` and the no-op `start()` are there too.
- The kernel's times are in milliseconds, so two writes in the same millisecond that leave the size unchanged look like one.

**`watch` and `promises.watch`** run on the kernel's file-change events, ([slicc-kernel#1047](https://github.com/ai-ecoverse/slicc-kernel/pull/1047)). They see changes made by any process in the kernel, or by the embedder. Node's events depend on the platform, so jsh reports what Node 22 reports on Linux (inotify), and the goldens are checked against Node on Linux (`fs-watch-node22`, `fs-watch-recursive-node22`, `fs-promises-watch-node22`, `fs-watch-follow-rename-node22`, `fs-watch-overwrite-node22`):
- `fs.watch` returns its `FSWatcher` with the watch already in place, so a change made right after the call is seen. In a directory, a create, delete, `mkdir`, `rmdir`, symlink and each name of a rename are `'rename'`; a write, append, truncate or `chmod` is `'change'`. Creating a file and writing it gives both. As with inotify, an event repeated before the program has read it counts once, so a write or an append is one `'change'`. Changes inside a subdirectory aren't reported without `recursive`.
- A watched file gives `'change'` for a write or a `chmod`. When it is removed, it gives `'change'`, `'rename'` and `'rename'` again, as inotify reports the link count, the delete and the end of the watch. A watched directory that is removed gives `'rename'` twice. Either way the watcher stays open, and keeps the program alive, until `close()`.
- A watch ([slicc-kernel#1358](https://github.com/ai-ecoverse/slicc-kernel/pull/1358)) follows renames, as inotify follows the inode. A directory above the watched path that is renamed gives no event, and the watch goes on with the moved path. The watched file or directory itself renamed gives one `'rename'` with its name, and no link-count `'change'`. Later events keep the name the watch was opened with. Only a removal ends the watch, and so does a rename of something else over it.
- All of a program's watches ([slicc-kernel#1360](https://github.com/ai-ecoverse/slicc-kernel/pull/1360)) share one queue, as libuv's share one inotify instance. The kernel numbers its operations, so jsh puts the events of every watch back in the order of the operations. The kernel hands out each watch's events apart, and a watch's later ones only once it asks again, so jsh reads them when two calls to the kernel in a row have brought no more: what the program's operations queued before that read, on every watch, comes out in their order (at most 16 calls, so a steady stream of changes still comes out). An event counts once only when it repeats the one just before it in that queue. An overwrite is a truncate and a write: a watch on the file, or on its directory, reports it once, and a program that watches both (as `recursive` does) gets it twice from the file's watch, as on Linux. An empty overwrite is one `'change'`, and so is an append, which writes at the end of the file rather than rewriting it, and so is a write through a descriptor (`fs.writeSync`, `ftruncate`, `writeFile` with flag `'r+'`), which writes in place. Two watchers on one file or directory share one inotify watch, so they hear each event in the order they were started. A file's watch hears an event after its directory's watch does, but a removed file or directory hears its own removal before its parent's watch hears the `'rename'`, as Linux 5.17 and later report it.
- `filename` is a string, or a `Buffer` with `encoding: 'buffer'`, or another encoding's string. `close()` emits `'close'` on the next tick, and nothing is delivered after it. `ref()`/`unref()` and `persistent: false` decide whether the watcher keeps the program alive, and `process.getActiveResourcesInfo()` lists each ref'd watcher as `'FSEventWrap'`. `signal` closes the watcher when it aborts. A missing path throws `ENOENT` (`syscall` `'watch'`) from `fs.watch` itself, and the arguments get Node's errors.
- `recursive: true` is Node's own Linux watcher (`recursive_watch.js`): a watch on every file and directory in the tree, relative filenames, `'close'` emitted at once, and a missing path's error is `stat`'s. As in Node on Linux, its `ref()` and `unref()` change nothing.
- `fs.promises.watch` iterates `{ eventType, filename }`. An aborted `signal` ends it with an `AbortError`. More events than `maxQueue` (2048) before the program reads them are an `ERR_FS_WATCH_QUEUE_OVERFLOW` with `overflow: 'error'`, or a warning for each event dropped with `'ignore'`. Events come one at a time, as in Node, so a waiting `next()` reads each as it comes, and the queue fills only while nothing is waiting. As in Node 22, `encoding: 'buffer'` is `ERR_INVALID_ARG_VALUE` here, and an unknown encoding's message has its two names swapped, and `recursive` iterates Node's Linux watcher, which drops events that come between two `next()` calls.

**Exports.** `require('fs')` and `import * as fs from 'node:fs'` have Node 22's keys (golden `fs-exports-node22`). The top-level `F_OK`, `R_OK`, `W_OK` and `X_OK` are read-only, the legacy `FileReadStream` and `FileWriteStream` are `ReadStream` and `WriteStream`, and `promises.constants` is `fs.constants`. A builtin's ESM namespace lists its names in sorted order, as a module namespace does.

**`glob`.** `glob`, `globSync` and `promises.glob` are Node 22.22's own `lib/internal/fs/glob.js`, on Node's copy of minimatch (10.0.3), over jsh's `lstat` and `readdir` (golden `fs-glob-node22`). They match case-sensitively, as on Linux. As in Node 22, `lstatSync` with `throwIfNoEntry: false` returns `undefined` for `ENOENT` only, so `globSync('file.js/x')` throws `ENOTDIR`.

**`Dir`.** `fs.Dir` is Node's class: `opendir`, `opendirSync` and `promises.opendir` return one, and `read`, `readSync`, `close`, `closeSync`, `entries`, `for await` and `Symbol.dispose`/`asyncDispose` behave as Node 22's, `ERR_DIR_CLOSED` and `ERR_DIR_CONCURRENT_OPERATION` included: an async read in flight queues the async calls after it and refuses the sync ones (golden `fs-dir-node22`). The kernel has no directory stream, so a `Dir` lists the directory when it is opened, and entries made or removed after that aren't seen.

**`readv` and `writev`.** `readv`, `readvSync`, `writev`, `writevSync` and `FileHandle.readv`/`writev` check their arguments as Node does and read or write the buffers in order on the descriptor (golden `fs-readv-writev-node22`). `writev` writes its buffers in one write. As in libuv, a `readv` of no buffers is `EINVAL`.

**`openAsBlob`** resolves to a `Blob` of the file's bytes, read when it is called; Node reads the file when the `Blob` is read, and fails then if the file has changed. A file that can't be opened throws Node's `ERR_INVALID_ARG_VALUE` (`Unable to open file as blob`) at the call (golden `fs-openasblob-node22`).

## `child_process`

**Async.** `spawn`, `execFile` and `exec` (through `sh -c`) run on the kernel's `ctx.spawn`:
- argv, env and cwd; Node's errors for a bad `cwd`, a missing command (`ENOENT`) and a file without `x` (`EACCES`), as `'error'` and then `'close'` with the negative errno, never thrown;
- stdio `inherit`, `pipe` and `ignore`, with streams on `.stdin`, `.stdout` and `.stderr`;
- the events `spawn`, `exit`, `close` and `error`; `.kill(signal)`; `.pid`.
- `ref()` and `unref()`, as in Node: an unref'd child doesn't keep the program alive, and nor does its stdio. A `.stdout` or `.stderr` pipe still being read does, until it ends or is `unref()`'d (golden `child-process-unref-node22`). tinypool's child-process workers rely on this.
- The child starts inside `spawn()` (`ctx.sync.spawn`), so `.pid` is set when it returns and a `kill()` or `process.kill(child.pid)` right after reaches it, as in Node.

**Finding the command.** A bare name is found on the child's `PATH` (`options.env`'s, else `/usr/bin:/bin`), as `execvp` does, for `spawn`, `execFile`, `spawnSync` and `execFileSync`:
- The first directory with an executable regular file wins. Directories and files without `x` are passed over, and an empty entry means the cwd.
- `EACCES` when only files without `x`, or directories, match. A directory run by path is `EACCES` too, as `execve` gives it. The kernel says so from 1.93.0; before that it says `ENOENT`, and jsh maps it.
- The kernel's commands are files in `/usr/bin` and `/bin`, so `PATH` order decides a clash, as it does for bash in the kernel. A name found nowhere on the child's `PATH` is `ENOENT`, as in Node, even when the kernel knows a command of that name (`env: { PATH: '/nonexistent' }` doesn't find `sh`).
- A name with a `/` is never searched.

**Sync.** `spawnSync`, `execSync` and `execFileSync` are Node 22's own option handling and result and throw shapes, on the kernel's `ctx.sync.run`. Supported:
- `encoding`, `input`, `cwd`, `env`;
- `stdio` `pipe`, `ignore` and `inherit` (the program's own fds and terminal included);
- `shell` (`/bin/sh`);
- `timeout` and `killSignal` (`ETIMEDOUT`), `maxBuffer` (`ENOBUFS`);
- `ENOENT` on `.error`;
- `execSync`/`execFileSync` throw with `status`, `signal`, `stdout`, `stderr`, `output` and `pid`.

**Other fds as stdio.** A stdio slot can be another fd.
- The program's own fds go straight to the child, and stdout and stderr sent to one fd keep the child's write order. An fd from `fs.openSync` (jsh's own) is written after the run. With `spawn`, it is written as the child writes, and one such fd as both stdout and stderr is one pipe, so their writes keep the child's order (golden `child-process-fd-shared-order-node22`).
- When the child exits, what it wrote is in the file before `'exit'`, and `'close'` comes right after, as in Node. A grandchild that inherits the fd doesn't hold `'close'` back, and what it writes later still reaches the file. The parent stays alive until the grandchild lets go of the fd, unless the child was `unref()`'d (golden `child-process-fd-grandchild-close-node22`).
- stdio slots past fd 2 are not passed to the child.

**`argv0`.** The child sees `options.argv0`, else the file as given, as its `argv[0]`. That holds for jsh's own `node` and `jsh` too, so a jsh child's `process.argv0` is the `argv0` it was given. A command whose manifest sets its own `argv0` keeps that.

**`detached: true`** makes the child lead a new session and process group (`setsid`, as Node does on POSIX).

**pnpm.** `fs.realpathSync`, `process.getuid`/`getgid` and `process.kill(self)` are there for pnpm's global command shims, which resolve their target and re-raise signals. Piped stdio loads `readable-stream` from sources embedded in the bundle, so a package installed with `pnpm add -g` (under `$PNPM_HOME/global/v11/<hash>/`) works.

**`fork` and `'ipc'` in `stdio`** work on a kernel that makes socketpairs and passes a child more descriptors than its stdio ([slicc-kernel#1093](https://github.com/ai-ecoverse/slicc-kernel/issues/1093)). The channel is Node 22.22.0's (golden `fork-ipc-node22`):
- It is one end of a unix socketpair. The child has the other end at the `'ipc'` index, fd 3 for `fork`, and finds it in `NODE_CHANNEL_FD`, which leaves its environment at start, as in Node.
- Messages are framed by Node's own `lib/internal/child_process/serialization.js`, `'json'` (the default) or `'advanced'` (V8's serialization, see `v8` below), so the bytes are Node's.
- In the parent: `send` (with its callback and `false` under backpressure), `connected`, `disconnect`, `channel` with `ref`/`unref`, `'message'` and `'disconnect'`. `'close'` waits for the channel's end. When the parent disconnected first, `'close'` never comes, as in Node.
- In the child: `process.send`, `process.connected`, `process.disconnect`, `process.channel`, `'message'` and `'disconnect'`. The channel keeps the child alive only while it has `'message'` or `'disconnect'` listeners.
- Messages whose `cmd` starts with `NODE_` are `'internalMessage'`s. `fork`'s and `spawn`'s IPC errors are Node's: `ERR_CHILD_PROCESS_IPC_REQUIRED`, `ERR_IPC_ONE_PIPE`, `ERR_IPC_SYNC_FORK`, `ERR_IPC_CHANNEL_CLOSED`, `ERR_IPC_DISCONNECTED`, and the `options.serialization` check.
- An exiting child's `'disconnect'` comes before its `'exit'`, as Linux closes its descriptors before the parent reaps it.
- `disconnect()` drops the sends the socket hasn't taken yet, as libuv cancels them when Node closes the channel; their callbacks get `null` (golden `fork-ipc-disconnect-queued-node22`).
- A send is written as libuv writes it: what the socket takes at once, and the rest queued and written as it has room, so both ends can send more than a socket holds before either reads (slicc-kernel 1.126.0's non-blocking writes, [slicc-kernel#1124](https://github.com/ai-ecoverse/slicc-kernel/issues/1124); golden `fork-ipc-both-ways-node22`).
- A handle is sent as Node sends it (`subprocess.send(message, sendHandle[, options][, callback])` and `process.send`), on slicc-kernel 1.159.0's descriptor passing over the socketpair, as `SCM_RIGHTS` ([slicc-kernel#1562](https://github.com/ai-ecoverse/slicc-kernel/issues/1562)): a `NODE_HANDLE` message carries it, the other end acknowledges it (`NODE_HANDLE_ACK`), and the sends after it wait for that. A listening `net.Server` comes as a `net.Server` listening on the same socket, and an `http` server or an Express app can listen on it (`listen(handle)`; golden `fork-ipc-send-server-node22`). A `net.Socket` comes as a `net.Socket` on the same connection, and the sender's is handed over: it reads and writes no more (`ERR_SOCKET_CLOSED`), and its server's `getConnections()` and `close()` count the receiver's sockets, as in Node (sticky sessions with `pauseOnConnect`: golden `fork-ipc-send-socket-node22`). With `keepOpen` both ends keep it (golden `fork-ipc-send-keep-open-node22`). A handle that is no socket or server is `ERR_INVALID_HANDLE_TYPE`; an unconnected or destroyed socket, or a server not listening, sends the message alone; a `TLSSocket` goes without its descriptor, the other end refuses it and the resend throws `ERR_INVALID_HANDLE_TYPE`, as in Node (golden `fork-ipc-send-handle-errors-node22`).
- Not as in Node: `dgram` sockets can't be sent (there is no `dgram`), and on a kernel without descriptor passing (the browser's) a send with a handle fails with `ERR_NOT_SUPPORTED`. Stdio slots past fd 2 other than `'ipc'` are still not passed.

## `net`, `http` and `https`

**Where they reach.** `net` and `http` are TCP on the kernel's sockets (`ctx.net`).
- Loopback (`127.0.0.0/8`, `localhost`, `*.localhost`, `0.0.0.0`) is always the kernel's own, IPv4 only. A server is reachable from other programs in the kernel and, as `<port>.kernel.localhost`, from the page.
- Another host is real TCP when the embedder gives the kernel an uplink that routes it (an exit node, or a route table). The name is resolved through the uplink, and the request goes out byte for byte.
- Without a route (no uplink, or an address outside its routes), the connect fails. `net` reports Node's error: `getaddrinfo ENOTFOUND <name>` for a name nothing resolves, else `connect <CODE> <host>:<port>`. `http.request` then sends the request through `fetch` instead (see the fetch fallback below).
- `https` goes through `fetch`, except a request with its own agent, a `ca` or a client certificate, or one to the kernel's own loopback, which is `http` on a `tls.connect` socket (see the `https` client below).

**`net`.** Servers and sockets, `allowHalfOpen` (a server's own property, as Node's, which its connections take), `end()` as a half-close (one before the socket has connected goes out once it has, after what was written, as in Node: golden `net-end-before-connect-node22`). Unix domain sockets (`path`) and `new net.Socket({ fd })` throw `ERR_NOT_SUPPORTED`. A write the kernel takes at once calls back on the next tick, as Node's does after `uv_try_write`, so an http response answered at once emits `'finish'` before the next pipelined request is parsed. A write it takes only in part sends the rest when the socket has room, and its callback waits for that (golden `net-write-callback-node22`). TLS sockets still call back once the kernel has taken the bytes.
- A socket whose peer has ended keeps the program alive only while it still writes, as a libuv stream does: with `allowHalfOpen` and nothing more to send, the program can exit with it half open (golden `net-half-open-exit-node22`). A write or `end()` still in flight when the peer ends keeps it alive until it is done (golden `net-half-open-pending-write-node22`).
- `net.connect` and `net.createConnection` take a socket's `allowHalfOpen` and `timeout` options, as Node does (golden `net-connect-half-open-node22`).
- A socket nobody reads stops reading once it holds its `readableHighWaterMark`, as Node's `readStop` does, so a peer's large write waits; it reads on when the program reads. While it waits, it doesn't keep the program alive by itself (golden `net-unread-backpressure-node22`).
- `resetAndDestroy()` closes the connection with an RST, as Node's, on slicc-kernel 1.155.0's `reset()` ([slicc-kernel#1530](https://github.com/ai-ecoverse/slicc-kernel/issues/1530)): the peer's read fails with `ECONNRESET`, so it gets `'error'`, then `'close'` with `true` (golden `net-reset-and-destroy-node22`). A socket still connecting resets once it has connected, and one without a connection gets `ERR_SOCKET_CLOSED`. On a `TLSSocket` it throws `ERR_INVALID_HANDLE_TYPE`, as Node's; the `net.Socket` under `tls.connect({ socket })` resets the TLS connection, so the server's socket gets `ECONNRESET`, or `'tlsClientError'` `ECONNRESET` during the handshake (golden `tls-reset-and-destroy-node22`). Still different:
  - In the same tick as a `write()`, `resetAndDestroy()` closes plainly, so the peer reads what was written, then its end, and `'close'` with `false`, as Node does on Linux, whose libuv reports the end that comes with the RST once the data is read (golden `net-reset-after-write-node22`). On macOS Node's peer gets `ECONNRESET` there too. In a later tick the peer reads what it already has, then `ECONNRESET`, on every platform (slicc-kernel 1.159.4, [slicc-kernel#1577](https://github.com/ai-ecoverse/slicc-kernel/issues/1577)).
  - On an uplink connection the kernel closes with a FIN and drops what it still holds to send, as the transport can't send an RST.
  - A server whose client resets during the handshake gets `'tlsClientError'` with Node's `read ECONNRESET` (`errno`, `syscall: 'read'`), and one whose client closes `socket hang up`, as in Node (slicc-kernel 1.159.4, [slicc-kernel#1578](https://github.com/ai-ecoverse/slicc-kernel/issues/1578), golden `tls-server-client-reset-node22`). On the client, Node's `TLSSocket` over a socket destroyed or reset during the handshake emits `'close'` with `true`, then an `EINVAL` error; jsh's emits `'close'` with `false`.
- A listening server's `_handle` has the `TCP` handle's `getsockname`, `close`, `ref`, `unref` and `hasRef` (golden `net-server-tcp-handle-node22`). Its other methods aren't there. Another server can listen on it (`listen(handle)`, `listen(server)`), and takes its connections from then on, as in Node.
- `pauseOnConnect` gives sockets that read nothing until the program calls `resume()`, as Node's (golden `fork-ipc-send-socket-node22`).
- `listen()` with no host (`listen(0)`, `listen(port)`, `listen()`) binds at once, as Node's does (the kernel's `ctx.sync.net.listen`): straight after the call the server is `listening` and `address()` has the port, so chai-http's `request(app)` works. `'listening'` comes on the next tick, and a bind that fails (`EADDRINUSE`, say) is an `'error'` on the next tick, not a throw. With a host, Node looks it up first, and so does jsh: an IP (`listen(0, '127.0.0.1')`) is bound on the next tick, as Node's `dns.lookup` answers an IP, so a `nextTick` queued after the call sees the server listening; a name such as `localhost` is bound once `dns.lookup` has answered, and a name nothing resolves is `getaddrinfo ENOTFOUND`. A server closed before its host is looked up never binds. `listen({ fd })` is `listen EINVAL` on the next tick: jsh can't listen on a descriptor it is given (golden `net-server-listen-sync-node22`, `chai-http-express-node22`).

**`http`'s classes.** `http.IncomingMessage`, `OutgoingMessage`, `ServerResponse`, `ClientRequest`, `Server` and `Agent` are function constructors with Node 22's prototype chains: `IncomingMessage` on `stream.Readable`, `OutgoingMessage` on the legacy `Stream`, `ServerResponse` and `ClientRequest` on `OutgoingMessage`, `Server` on `net.Server` and `Agent` on `EventEmitter`. Their methods are on the prototypes, as Node's, so the request and response a server gets are built from them (golden `http-message-classes-node22`).
- A prototype swap keeps everything working, as **Express** does with `app.request` and `app.response`. Express 5 runs: routing, `express.json()`, `res.json`, `res.send`, `res.redirect`, `express.static` and error handlers (golden `express-basic-node22`). **Koa** and **Fastify** run too.
- `new http.IncomingMessage(socket)` and `new http.ServerResponse(req)` stand alone, and `http.ServerResponse.call(this, req)` works for a `util.inherits` subclass with a socket of its own (`assignSocket`). That's what light-my-request, and so Fastify's `inject`, does.
- `OutgoingMessage` has Node's header API: `setHeader` (with Node's checks), `appendHeader`, `setHeaders`, `getHeader`, `getHeaders`, `getHeaderNames`, `getRawHeaderNames`, `hasHeader`, `removeHeader`, `addTrailers`, and the `writable*`, `headersSent` and `errored` getters. A value is kept as given (`getHeader` of a number is the number).
- `ClientRequest` has `setNoDelay`, `setSocketKeepAlive` and `clearTimeout` (superagent calls them), and `req.socket` once it has one. `http.Server()` and `http.Agent()` work without `new`.
- The `headers` of a request and of a response join a repeated field as Node does (`, `, `; ` for `cookie`; `set-cookie` is a list).
- As with Node 22's llhttp, a repeated `Content-Length`, one that isn't a number, or `Content-Length` with `Transfer-Encoding` is a parse error (`HPE_UNEXPECTED_CONTENT_LENGTH`, `HPE_INVALID_CONTENT_LENGTH`, `HPE_INVALID_TRANSFER_ENCODING`). A server emits `'clientError'`, or with no listener answers `400 Bad Request` and closes; a client request gets `'error'` (golden `http-content-length-framing-node22`).
- `requireHostHeader` is Node's: on by default, an HTTP/1.1 request without a `Host` header is answered `400 Bad Request` with `Connection: close`, and the server emits no `'request'` for it. An empty `Host` and HTTP/1.0 are served, and `requireHostHeader: false` (an option, or the property set later) turns the check off (golden `http-require-host-header-node22`).
- `writeHead` with a list of headers replaces those names first and keeps repeats within the list, as Node's does; a list of an odd length throws `ERR_INVALID_ARG_VALUE`.
- Not there: `_addHeaderLine` and its kin, `writeEarlyHints`, `writeProcessing`, the deprecated `_headers`/`_headerNames`, and `https.Agent`'s session cache.
- `https.Server` and `https.createServer` make a `tls.Server` with Node's options, listeners (`'connection'`, `'secureConnection'`, `'tlsClientError'`, `'listening'`) and `allowHalfOpen` (golden `https-classes-node22`). It listens and serves `http`'s server over the `tls.Server`'s TLS (see TLS servers under `tls`): a plain handler or an **Express** app, with `req.socket` the `TLSSocket` (`req.secure`, `req.protocol` `https`). A `'tlsClientError'` is its `'clientError'`, or destroys the connection without a listener, as in Node (golden `https-server-node22`).

**`http` server.**
- Request bodies are read whole before the `'request'` handler runs. A body over 64 MiB gets `413 Payload Too Large`.
- Responses stream, as Node's: a `write()` before `end()` (or `flushHeaders()`) sends the head and each chunk as it comes, chunked unless a `Content-Length` is set. SSE and long-poll servers work. `end()` alone sends one framed response.
- The head is Node 22's: `writeHead()` renders it into `_header` (so `headersSent` is `true` from then on), and it goes out with the first `write()`, `end()` or `flushHeaders()` (`_headerSent`). The framing is decided when it is rendered: `end(body)` with no head yet has a `Content-Length`; a head rendered before the length is known (`writeHead()`, `write()`, `flushHeaders()`) is chunked; HEAD, 1xx, 204 and 304 responses have no body; an explicit `Content-Length` or `Transfer-Encoding` is kept; an HTTP/1.0 client gets no chunking unless it sent `TE: chunked`, and a body with no length closes the connection. `writeHead(status, headers)` on a response with no headers set keeps the headers out of `getHeaders()`, as Node does. `cork()` joins the chunks written meanwhile into one, `strictContentLength` is checked, and `'prefinish'`, `'finish'` and `'close'` come in Node's order (golden `http-writehead-framing-node22`).
- A deliberate difference from Node 22.22, whose framing desyncs a kept-alive connection here: `end()` while `cork()` is still held sends the corked chunks before the last `0` chunk, as Node 26 does. Node 22.22 sends the `0` chunk first, so the peer reads the body as the next response. The chunks stay as Node 22 cuts them; Node 26 also joins the ones written before the head went out (integration test `http-end-corked`).
- An `end()` that throws `ERR_HTTP_CONTENT_LENGTH_MISMATCH` puts nothing on the wire, as in Node 22 and 26: what it would have written waits for the next `end()` that succeeds, as it does on Node's corked socket (golden `http-writehead-framing-node22`, integration test `http-end-corked`).
- Headers can't change once the head is sent (`ERR_HTTP_HEADERS_SENT`).
- `http.STATUS_CODES` is Node 22's whole table. A status not in it gets the reason phrase `unknown`, as in Node.
- Keep-alive works as in Node 22:
  - A connection stays open after a response that may leave it so: an HTTP/1.1 request without `Connection: close`, or an HTTP/1.0 one with `Connection: keep-alive`, and a framed body. Such a response says `Connection: keep-alive` and `Keep-Alive: timeout=N` (with `, max=M` when `maxRequestsPerSocket` is set); any other response says `Connection: close`.
  - Requests on a connection are served one after another, pipelined ones in order. As in Node 22, every pipelined request that has arrived is parsed, whatever the responses in front of it are doing. Each is emitted at its head and its body pushed as it comes, and the ticks and microtasks run after each piece of body before the next request is parsed. Data after a request that closes the connection (`Connection: close`, HTTP/1.0) is `HPE_CLOSED_CONNECTION`, also when it comes in a later packet. CR and LF there are skipped, as in llhttp (goldens `http-server-closed-crlf-node22`, `http-server-pipelined-order-node22`).
  - An idle connection closes after `server.keepAliveTimeout` (5 s) plus `server.keepAliveTimeoutBuffer` (1 s), as in Node 22. `closeIdleConnections()` and `closeAllConnections()` end connections as Node's do.
  - `close()` closes the connections that are idle at that moment. One that is busy keeps serving after its response, as in Node 22: it still says `Keep-Alive`, takes further requests, and closes when it goes idle for that long or the client ends it. The callback waits until every connection has closed.
  - `maxRequestsPerSocket` is honoured. Headers that don't arrive within `headersTimeout` get `408`.
- An `Upgrade` request goes to `'upgrade'` listeners, with the socket and what followed the head. The socket is the program's from then on: paused, with none of the server's listeners, so its errors don't reach `'clientError'` and a client's FIN doesn't close it (golden `http-upgrade-handover-node22`). Without a listener, it is an ordinary request.
- A `CONNECT` request goes to `'connect'` listeners (request, socket, head), never to `'request'`, and the socket is the program's from then on: the server doesn't end it on the client's FIN. Without a listener the socket closes with no status line (golden `http-connect-node22`).
- Header names are written as they were set.

**`http` client.**
- With a `Content-Length`, request body bytes stream as written. Without one, a body written before `end()` is sent chunked, each write as it comes, as in Node (golden `http-client-request-framing-node22`); a body given only to `end()` is sent with its length. A `GET`, `HEAD`, `DELETE`, `OPTIONS`, `TRACE` or `CONNECT` body, and one with a `Transfer-Encoding` other than `chunked`, has no framing, as in Node: the head goes out with the first write, and each write as it comes, with no `Content-Length`, even for a body given only to `end()` (golden `http-client-unframed-body-node22`). A server reads what follows such a body as the next request, as it would from Node.
- `'response'` comes at the head, and the body streams as it arrives: by `Content-Length`, chunked, or until the peer's FIN. `socket.end` half-closes. A chunked body's trailers are `res.rawTrailers` and `res.trailers` by its `'end'`.
- `http.validateHeaderName`, `http.validateHeaderValue` and `http.setMaxIdleHTTPParsers` are Node's (golden `http-validate-headers-node22`).
- A `ClientRequest` has its `Host` header from the start, set after the given headers and before the agent's `addRequest` sees the request. It's absent with `setHost: false`. The request line is the request's `method` and `path` as they are when it's sent. `_header` and `_implicitHeader()` are Node's. That lets **http-proxy-agent** rewrite the path to the absolute URL and send through a plain `http://` proxy.
- `headers` as an array, flat (`[name, value, …]`) or in pairs, is Node's: the head is rendered at once, with the headers as given and in order, no `Host` added and `Connection` after them, so `headersSent` is `true`, `getHeaders()` is `{}` and `setHeader` throws `ERR_HTTP_HEADERS_SENT`. An odd length is `ERR_INVALID_ARG_VALUE`, and each name and value is checked (golden `http-request-array-headers-node22`). Not as in Node: a body with neither `Content-Length` nor `Transfer-Encoding` in the array is sent with a `Content-Length`, where Node chunks it.
- `http.Agent` follows Node's `_http_agent.js` request path (`addRequest` → `createSocket` → `createConnection`), so **agent-base** subclasses work for plain `http`. `getName`, `destroy`, `keepSocketAlive`, `reuseSocket`, `removeSocket`, and `sockets`/`freeSockets`/`requests` are present.
- `http.globalAgent` keeps sockets alive, as in Node 22 (`keepAlive: true`, `scheduling: 'lifo'`, `timeout: 5000`). An agent with `keepAlive` reuses a socket once its response is done (`'free'`, then `req.reusedSocket`), queued requests first. As in Node 22, a server's `Keep-Alive: timeout=N`, less `agentKeepAliveTimeoutBuffer` (1 s), caps a free socket's timeout, and a hint that leaves nothing (`timeout=1`) means the socket isn't reused. Free sockets don't keep the program alive, and one the server closes leaves the pool. `agent: false`, or an agent without `keepAlive`, sends `Connection: close`.
- A connection that closes before its response gives `socket hang up` (`ECONNRESET`). A `101` response is `'upgrade'` (response, socket, head), and without a listener the connection closes. The response to a `CONNECT`, whatever its status, is `'connect'` (response, socket, head) and never `'response'`; without a listener the connection closes too.

**The fetch fallback** (plain `http` without a route, and an `https` request without an agent). The request is sent once it has ended, through jsh's `fetch`: the embedder's transport, and `host.slicc.internal` through the kernel's proxy. What a fetch can't carry, it doesn't:
- **No raw socket.** `res.socket` and `req.socket` are `null`. There is no `'socket'` or `'connect'` event, no Agent pooling or keep-alive, no `upgrade` or `CONNECT`, no 1xx responses or `Expect: 100-continue`, and no trailers.
- **Normalized headers.** Response header names arrive lowercased in `rawHeaders`, and repeated headers other than `set-cookie` are joined. The headers fetch owns (`Host`, `Connection`, `Content-Length`, `Transfer-Encoding`, `Keep-Alive`, `Expect`, `Upgrade`, `TE`, `Trailer`) are fetch's to set, so a custom `Host` doesn't reach the server.
- **Buffered upload.** The request body is sent whole, after `end()`.
- **Streamed download.** The response body streams as it arrives. `set-cookie` is an array, and a missing reason phrase is Node's.
- **Redirects.** Requests use `redirect: 'manual'`, so a 3xx shows as `statusCode` and `Location`, as in Node. A browser transport can't do that (an opaque redirect), so there jsh follows redirects instead (see below).
- **Refused, not changed.** What fetch can't send fails with `ERR_NOT_SUPPORTED` before anything goes out: the methods it forbids (`CONNECT`, `TRACE`, `TRACK`), and a `GET` or `HEAD` with a body.
- **Agents.** A request with its own agent (a subclass of `http.Agent`, or one with its own `createConnection`, `addRequest` or `createSocket`, as a proxy's has), a `socketPath`, or a kernel without `ctx.fetch` gets the connect error instead. A plain `new http.Agent(…)` takes the fallback.
- If `fetch` has no network either, the error is the connect's (`getaddrinfo ENOTFOUND`, `connect ENETUNREACH`). A name the transport can't resolve is `getaddrinfo ENOTFOUND <name>` (or `EAI_AGAIN`): the kernel passes the resolver's errno.
- Errors name a loopback name by its address, `127.0.0.1`, as Node's resolver gives it. `res.req` has the request's `method`, `path`, `host` and `protocol`.

**`https` client.** `https.request` and `https.get` take the fetch fallback above, except for a request with its own agent (an `https.Agent`, a proxy agent's) or its own `createConnection` (ws's `wss://`), for a request with a `ca` (with `https.globalAgent`, or a fresh agent for `agent: false`, as in Node). The same goes for a request with a client certificate (`cert` and `key`), and for one to the kernel's own loopback (`localhost`, `127.x`), which the kernel's handshake reaches and `fetch` doesn't, so `https.get` reaches a server of this kernel and verifies it as Node does (`DEPTH_ZERO_SELF_SIGNED_CERT` for a self-signed one without its `ca`; golden `https-server-node22`). Such a request is `http`'s socket client on a `tls.connect` socket (see `tls`), with keep-alive, `rawHeaders` as sent, trailers (`rawTrailers`, `trailers`) and `'upgrade'`. It never falls back to `fetch`.
- The request's own options reach the agent, as in Node (`addRequest` → `createSocket` → `createConnection`), so `ca`, `cert`, `key`, `passphrase`, `servername` and `rejectUnauthorized` reach `tls.connect`. An `https.Agent({ cert, key })` gives each of its sockets the certificate. The SNI is Node's `calculateServerName`: the `Host` header's name, else `host`, never an IP address.
- `https.Agent` is Node's: `http.Agent` with TLS sockets, `defaultPort` 443, and the TLS options in its socket names.
- The fetch fallback's request is an `http.ClientRequest` on `https.globalAgent`, as Node's (golden `https-classes-node22`).
- Its headers are Node's: a `Headers` object is ignored (it has no own keys), a `null` value is sent as `null`, and an `undefined` one throws `ERR_HTTP_INVALID_HEADER_VALUE` (golden `https-classes-node22`).
- `pfx` throws `ERR_NOT_SUPPORTED`.
- Without an agent, `rejectUnauthorized: false` is accepted but ignored: fetch verifies. Over a socket, it's `tls.connect`'s (see `tls`).
- Why a request without an agent stays on `fetch`: to a host the uplink doesn't route, the socket would be the transport's TLS (A1) as well, with the same headers and no trailers, and a name that doesn't resolve would come back as a `502` response instead of Node's `getaddrinfo ENOTFOUND` error, which `fetch` gives.
- Redirects: requests use `redirect: 'manual'`, so a redirect shows as `statusCode` and `Location`, as in Node. On the browser entry the transport may refuse that with `ENOTSUP`; jsh then falls back to `'follow'`, so plain requests work but a redirect is followed instead of surfaced. The Node entry's transport supports manual redirects. Embedders with `traits.redirectHops` ([slicc-kernel#315](https://github.com/ai-ecoverse/slicc-kernel/issues/315)) can surface redirects in the browser.

**Not available:** what `tls` has no handshake for (below).

## `tls`

`require('tls')` and `import … from 'node:tls'` load with Node 22.22.0's exports. **ws** runs: its `ws://` server over an `http` server's `'upgrade'`, its client, and (see below) its `wss://` client. **agent-base**, **http-proxy-agent** and **https-proxy-agent** load too. http-proxy-agent sends plain `http` requests through an `http://` proxy (see `http`). https-proxy-agent's tunnel needs TLS over an open socket, which works (below).

The kernel does the TLS, by one of two paths ([slicc-kernel#914](https://github.com/ai-ecoverse/slicc-kernel/issues/914)). jsh has no TLS of its own.

**A2: the kernel's own handshake** ([slicc-kernel#922](https://github.com/ai-ecoverse/slicc-kernel/issues/922)), for a host the kernel's uplink routes as raw TCP. The embedder installs `@ai-ecoverse/wasm-tls-engine` (4.2.0-2 or later; 4.2.0-3 for client certificates and the SNI below). What works, as in Node:
- **Any port and protocol.** `tls.connect({ host, port })` with any ALPN list: pg, SMTPS, IMAPS, MQTT over TLS, Redis over TLS, HTTP/2's ALPN. jsh asks for the kernel's handshake on any port but 443. On 443 the kernel keeps the transport's path (A1, below) unless the call needs a real handshake: a `ca`, ALPN without `http/1.1`, `rejectUnauthorized: false`, a `checkServerIdentity` of its own or a client certificate. To a host the uplink doesn't route, the call falls back to A1.
- **STARTTLS and TLS over an open socket.** `tls.connect({ socket })` and `new tls.TLSSocket(socket, { isServer: false })` over a `net.Socket` upgrade its connection in place (`ctx.net.connect({ socket, host, tls })`). pg's `SSLRequest`, nodemailer's `STARTTLS` and https-proxy-agent's `CONNECT` tunnel work. What was written in plain text goes out before the handshake, and the plain socket emits nothing more, then `'close'` just before the TLS socket's, as in Node. A socket that is still connecting is upgraded once it has connected. A bare `TLSSocket` starts its handshake at its first write and emits `'secure'`, not `'secureConnect'`, and doesn't verify (`authorized` stays `false`), as in Node.
- **A custom `ca`**, in `tls.connect`, `createSecureContext({ ca })` (and `secureContext`), and `https.request`. It replaces the kernel's trust store (Mozilla's roots, which the engine package ships), as in Node.
- **Client certificates** ([slicc-kernel#1004](https://github.com/ai-ecoverse/slicc-kernel/issues/1004)). `cert` (PEM, DER or a list: the leaf, then its intermediates), `key` (PEM PKCS#8, encrypted or not, PKCS#1 or SEC1, or `[{ pem, passphrase }]`) and `passphrase` work in `tls.connect`, `createSecureContext` (and `secureContext`), `https.request` and an `https.Agent`. pg's `sslcert` and `sslkey` work too.
  - As in Node, a certificate is offered only with both: `cert` without `key`, or the reverse, offers none, and a server that requires one refuses.
  - `getCertificate()` is the context's certificate as Node shows it (the same fields as `getPeerCertificate()`, without `issuerCertificate`), whether it was asked for or not, and `{}` without one.
  - Bad key material gets Node's errors, with OpenSSL's message, `library`, `reason` and `opensslErrorStack`:
    - `ERR_OSSL_BAD_DECRYPT` for a wrong passphrase, and for an encrypted key without one (OpenSSL decrypts with an empty one), as Node gives. Its `opensslErrorStack` is PKCS#8's (`pkcs12 cipherfinal error`) or a traditional PEM key's (`PEM routines::bad decrypt`);
    - `ERR_OSSL_UNSUPPORTED` when a wrong decrypt passes the padding check but isn't a key (about one key in 270), as Node gives. Its `opensslErrorStack` is OpenSSL's ASN.1 errors for the decrypted bytes (`header too long`, `wrong tag`, `too long`, `sequence not constructed`, `field missing`, …), through the first field's header. Past that, jsh can't reproduce OpenSSL's decoder, and the error has no `opensslErrorStack` (golden `tls-wrong-passphrase-node22`);
    - `ERR_OSSL_UNSUPPORTED` for a key that isn't one, and for any DER key, as Node's `tls` reads only PEM;
    - for a PKCS#8 key's PBKDF2 parameters, OpenSSL's errors whatever the passphrase: `ERR_OSSL_EVP_UNSUPPORTED_KEYLENGTH` for a key length that isn't the cipher's, and for an iteration count (OpenSSL keeps its low 32 bits, as a signed int) `ERR_OSSL_INVALID_ITERATION_COUNT` for 0 and `ERR_OSSL_CRYPTO_PARAM_UNSIGNED_INTEGER_NEGATIVE_VALUE_UNSUPPORTED` for a negative one;
    - `ERR_OSSL_X509_KEY_VALUES_MISMATCH` for another certificate's key, thrown by `createSecureContext` and so by `tls.connect`, `https.request`, `tls.createServer` and `addContext` (golden `tls-key-mismatch-node22`): the kernel's engine checks the pair when the context is made, on a loopback listener jsh closes at once;
    - `ERR_OSSL_PEM_NO_START_LINE` or `ERR_OSSL_PEM_BAD_END_LINE` for a certificate that isn't one.
  - One key per context: a list of more than one key (Node's RSA plus EC) is `ERR_NOT_SUPPORTED`.
- **The SNI is Node's.** Node sends a server name only for a `servername` that `tls.connect` is given, not for `host`, and never for a bare `TLSSocket`. The kernel sends exactly that (`sni: false` otherwise), and still checks the certificate against `servername || host`. `servername: ''` sends none.
- **`getCipher()`** is Node's `{ name, standardName, version }`: OpenSSL's name, IANA's, and the suite's own version, from the kernel's session.
- **Verification is Node's.** The kernel verifies the chain and reports what it found; jsh then applies Node's `onConnectSecure` before any application byte is sent or delivered:
  - the chain's error has Node's code and OpenSSL's message: `SELF_SIGNED_CERT_IN_CHAIN`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `CERT_HAS_EXPIRED`, `CERT_NOT_YET_VALID`, `INVALID_PURPOSE`;
  - then `checkServerIdentity(servername || host, cert)`, Node's or the caller's, on the leaf with its issuers linked, so `ERR_TLS_CERT_ALTNAME_INVALID` has Node's `reason`, `host` and `cert`. An error it returns refuses the connection (`authorizationError` is its `code`, else its message). One it throws is uncaught, out of the `'secure'` listener, as in Node;
  - `rejectUnauthorized: false` connects and sets `authorized: false` and `authorizationError` (the code). Otherwise the socket is destroyed with the error, after `'secure'`.
- **The session.** `getPeerCertificate()` is Node's object, read from the DER chain the kernel hands over (`subject`, `issuer` and `infoAccess` with null prototypes, `subjectaltname`, `ca`, `bits`, `pubkey`, `modulus`/`exponent` or `asn1Curve`/`nistCurve`, `valid_from`, `valid_to`, the three fingerprints, `ext_key_usage`, `serialNumber`, `raw`). `getPeerCertificate(true)` links `issuerCertificate` through the chain the server sent, then the `ca` given, and a self-signed root points to itself. `getProtocol()` is `'TLSv1.3'` or `'TLSv1.2'`, `alpnProtocol` is the agreed protocol or `false`, `servername` is the SNI given (or `false`), and `isSessionReused()` is `false`.
- **Still different:**
  - **`'keylog'`** (slicc-kernel 1.154.0, [slicc-kernel#1504](https://github.com/ai-ecoverse/slicc-kernel/issues/1504)) is Node's: each NSS key log line as a `Buffer` ending in a newline, before `'secureConnect'`. It comes on a `TLSSocket`, on a `tls.Server` or `https.Server` with the socket, and on an `https.Agent` with its socket. `--tls-keylog=<file>` appends every socket's lines to the file (mode 600), with Node's warning (golden `tls-keylog-node22`, `tls-keylog-file-node22`).
    - The lines are the session's secrets, and a session the kernel logs is never sealed. So jsh asks for them only for a socket with a `'keylog'` listener when its handshake starts: one added in the same tick as `tls.connect`, a server's (or `https.Agent`'s) when the connection comes, or `--tls-keylog`. A socket without one is never logged.
    - On TLS 1.3 they are Node's five lines, the four traffic secrets and `EXPORTER_SECRET` (slicc-kernel 1.157.1, [slicc-kernel#1545](https://github.com/ai-ecoverse/slicc-kernel/issues/1545)).
    - Lines come only from the kernel's handshake. `tls.connect` with a listener therefore takes it on port 443 too. To a host the uplink doesn't route, the transport's TLS (A1) gives none.
  - `getEphemeralKeyInfo()`, `getFinished()`, `getPeerFinished()`, `getSession()`, `getTLSTicket()` and `getSharedSigalgs()` are `null`, because the kernel doesn't report them. `getPeerX509Certificate()` and `getX509Certificate()` are `undefined` (jsh has no `X509Certificate`). There's no session resumption, no revocation check, and no `minDHSize` check.
  - **A server's alert** is Node's. It has OpenSSL's code for the alert the server sent (`ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED` when a TLS 1.3 server requires a client certificate it didn't get, `ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE` on TLS 1.2), with `library`, `reason`, and Node's message, OpenSSL's function (`ssl3_read_bytes`) included, ending in `SSL alert number <n>`. Node's message also carries its thread and the OpenSSL source position, which jsh doesn't have.
  - **Encrypted keys.** A wrong or missing passphrase is thrown, as in Node. jsh decrypts AES-128, AES-192 and AES-256 CBC keys itself (PKCS#8 with PBES2 and PBKDF2, or traditional PEM), to tell a bad padding from bytes that aren't a key. PBES2 PKCS#8 keys with Camellia or ARIA (128, 192 or 256-bit CBC) are the kernel's engine's to read (wasm-tls-engine 4.2.0-12, [slicc-kernel#1564](https://github.com/ai-ecoverse/slicc-kernel/issues/1564)): with the right passphrase they load, and a wrong or missing one is `ERR_OSSL_BAD_DECRYPT` with Node's `opensslErrorStack`, thrown by `tls.createSecureContext` (and so `tls.connect` and `tls.createServer`) when it has the certificate too (golden `tls-key-camellia-aria-node22`). Still different: a Camellia or ARIA key without a certificate isn't checked until it's used; about one wrong passphrase in 256 passes the padding check and is `ERR_OSSL_BAD_DECRYPT`, where Node's decoder gives `ERR_OSSL_UNSUPPORTED`; and a key encrypted with DES-EDE3 (3DES), with PBES1 (such as `PBE-SHA1-3DES`), or as traditional PEM with a cipher other than AES is the engine's `ERR_OSSL_UNSUPPORTED` even with the right passphrase, as Mbed TLS 4 has no DES and reads only AES in a `DEK-Info` (a server's is thrown by `tls.createServer` or `addContext`, a client's fails the connect). Text that isn't a key or a certificate at all is thrown, as in Node.
  - **No SNI for an IP address.** For a `servername` that is an IP address the kernel sends no SNI, as TLS says. Node sends it, with DEP0123's warning.
  - **The chain's verdict.** jsh asks the kernel for the session whatever the chain says (`rejectUnauthorized: false` on its side), because Node's errors need the server's chain: `cert` and `reason` on `ERR_TLS_CERT_ALTNAME_INVALID`, which a refused connect doesn't carry. The kernel's verdict on the chain alone (`chainError`: `DEPTH_ZERO_SELF_SIGNED_CERT`, `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `INVALID_PURPOSE`, …) is the one jsh gives, and `checkServerIdentity` judges the name.
  - A handshake failure other than the certificate's is `ERR_SSL_HANDSHAKE_FAILURE` with the engine's reason, and a server that closes during the handshake is Node's `ECONNRESET` ("Client network socket disconnected before secure TLS connection was established"). A socket destroyed during its handshake closes the connection at once, as Node's does, so the server sees the client leave (golden `tls-connect-destroyed-handshake-node22`). Sealed placeholders written into an A2 connection reach the server unsubstituted (the kernel's `substitutes: false`).
  - **A reply that isn't TLS** (slicc-kernel 1.156.0, [slicc-kernel#1548](https://github.com/ai-ecoverse/slicc-kernel/issues/1548)) is Node's error, which the kernel tells apart by the reply's first record as OpenSSL does: `ERR_SSL_PACKET_LENGTH_TOO_LONG` for most plain text (`nope`, `HTTP/1.1 …`, `* OK …`), `ERR_SSL_WRONG_VERSION_NUMBER` for a major version other than 3 (`220 …`, `SSH-2.0…`, `+OK …`), `ERR_SSL_HTTP_REQUEST` for `GET ` and `PUT `, `ERR_SSL_DATA_LENGTH_TOO_LONG` for a record over 16384 bytes and `ERR_SSL_UNEXPECTED_MESSAGE` for a handshake record that isn't a ServerHello, with Node's `library`, `reason` and message, OpenSSL's function included (golden `tls-plain-text-reply-node22`). Node's message also has its thread and source position. For an SSLv2 version (`0x0002`) Node's names `tls_get_more_records`, where jsh's names `tls_validate_record_header`, as for the other wrong versions.
  - **A write before a failed handshake** (`write()` or `end()` on the socket, an `https` request that is ended) turns OpenSSL's error, a reply that isn't TLS or the server's alert, into Node's `EPROTO` from the write: `write EPROTO <OpenSSL's message>`, with `errno` and `syscall: 'write'` (golden `tls-write-before-failed-handshake-node22`). A server that closes during the handshake and a refused certificate keep their errors, as in Node. The write's callback still runs at once, where Node's gets the `EPROTO` error.
- **Refused with `ERR_NOT_SUPPORTED`:** `pfx` (the kernel's TLS engine reads no PKCS#12: pass `cert` and `key`), a client certificate for a host the uplink doesn't route, TLS over a stream that isn't a `net.Socket`, TLS over a socket the uplink doesn't route (a loopback one), and a `ca` for a host the uplink doesn't route.

**A1: the transport's TLS** ([slicc-kernel#923](https://github.com/ai-ecoverse/slicc-kernel/issues/923)), for every other `tls.connect`. The kernel serves the plain HTTP/1.1, and WebSocket upgrades, through the embedder's transport, which does the real handshake and verifies the peer. Sealed placeholders are substituted, as for `fetch`.
- `'connect'`, `'secure'` and then `'secureConnect'` (the callback) come once the kernel has the session. `authorized` is the transport's (`true`), and so is `alpnProtocol` (`'http/1.1'`). `servername` is the SNI given, else `false`, as in Node.
- `getPeerCertificate()` is `{}`, and `getProtocol()` is `null`: the transport keeps the certificates, so `checkServerIdentity` isn't called. `rejectUnauthorized: false` changes nothing, because the transport always verifies.
- What the transport won't carry fails with `ERR_NOT_SUPPORTED` on the socket's `'error'`: another protocol's well-known port (465, 993, 995, 636, 853, 8883, …), and ALPN without `http/1.1`.
- So `https` with an agent and ws's `wss://` client work there.

**The kernel's own loopback** (slicc-kernel 1.149.0, [slicc-kernel#1490](https://github.com/ai-ecoverse/slicc-kernel/pull/1490)). `tls.connect` to `localhost` or `127.x` is the kernel's handshake over its loopback, with the client's checks above (a `ca`, client certificates, ALPN, the SNI, `checkServerIdentity`), so a program reaches another's TLS server. A closed port is Node's `connect ECONNREFUSED`. `*.localhost`, `0.0.0.0` and `::1` stay `ERR_NOT_SUPPORTED`.

**TLS servers** (slicc-kernel 1.149.0, [slicc-kernel#1490](https://github.com/ai-ecoverse/slicc-kernel/pull/1490)). `tls.createServer` and `https.createServer` listen with the program's own certificate and key. Each connection the server accepts is Node's: a raw `net.Socket` on `'connection'`, which Node's `tlsConnectionListener` wraps in a server `TLSSocket`, and the kernel's handshake on it (`ctx.net.secure`). Then `'secure'` and the server's `'secureConnection'`, or `'tlsClientError'` (golden `https-server-node22`):
- **Options:** `key` (with `passphrase`, or `[{ pem, passphrase }]`), `cert` (the leaf, then its intermediates), `ca`, `requestCert`, `rejectUnauthorized`, `ALPNProtocols` (the server's preference: the first one the client also offers) and `handshakeTimeout`. A wrong or missing passphrase and a key for another certificate are thrown by `createServer` (and `setSecureContext`), with Node's `ERR_OSSL_BAD_DECRYPT` and `ERR_OSSL_X509_KEY_VALUES_MISMATCH`: jsh asks the kernel to import the pair once, on a listener of its own that it closes at once.
- **Client certificates** are checked as Node's server checks them. With `requestCert` and `rejectUnauthorized` (the default), a client without a certificate is `'tlsClientError'` `ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE`, and one whose certificate doesn't reach the `ca` is closed, then `'tlsClientError'` `ECONNRESET` (`socket hang up`), as Node's. Neither reaches `'secureConnection'` or an `https` handler: the kernel fails the handshake, and jsh destroys a socket the session didn't authorize before it releases it. With `rejectUnauthorized: false` the certificate is only asked for: the socket comes with `authorized: false` and Node's `authorizationError` (`DEPTH_ZERO_SELF_SIGNED_CERT`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `UNABLE_TO_GET_ISSUER_CERT` without one). Without a `ca`, the certificate is checked against the kernel's bundled roots, as Node checks it against its own (slicc-kernel 1.151.0, [slicc-kernel#1503](https://github.com/ai-ecoverse/slicc-kernel/issues/1503)): one that no public root issued is refused, or with `rejectUnauthorized: false` comes with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` (`DEPTH_ZERO_SELF_SIGNED_CERT` for a self-signed one).
- **The socket:** `authorized`, `authorizationError`, `alpnProtocol` (or `false`), `servername` (the client's SNI, or `false`), `getProtocol()`, `getPeerCertificate()` (the client's, `{}` without one; `getPeerCertificate(true)` links its issuers through the `ca`), `getCertificate()` (the server's), `getCipher()` (Node's `{ name, standardName, version }`, the suite the client agreed, slicc-kernel 1.151.0, [slicc-kernel#1500](https://github.com/ai-ecoverse/slicc-kernel/issues/1500)), `isSessionReused()` (`false`) and `encrypted`. The suite is the kernel's choice, as it takes no `ciphers` or `honorCipherOrder`: between two of jsh's sockets it is `TLS_CHACHA20_POLY1305_SHA256`, the kernel client's first, where two of Node's agree on `TLS_AES_256_GCM_SHA384`.
- **Handshake failures** are `'tlsClientError'` with Node's error: `ERR_SSL_NO_APPLICATION_PROTOCOL` for ALPN in common with none, `ERR_TLS_HANDSHAKE_TIMEOUT` after `handshakeTimeout`, the client's alert by OpenSSL's name (`ERR_SSL_TLSV1_ALERT_UNKNOWN_CA`, …), `ECONNRESET` `socket hang up` for a client that leaves, and `ERR_SSL_NO_SUITABLE_SIGNATURE_ALGORITHM` for a server without a certificate and key, once the client's hello is in, with alert 40 to the client, as in Node (golden `tls-server-no-cert-node22`; at once on a kernel without the TLS engine). A client that sends a plain HTTP request is `ERR_SSL_HTTP_REQUEST`, as in Node (slicc-kernel 1.150.0), with Node's message and OpenSSL's function in it (golden `tls-server-plain-client-node22`). Another failure is `ERR_SSL_HANDSHAKE_FAILURE` with the engine's reason. Node's message also has its thread and source position, which jsh doesn't. After `handshakeTimeout`, a `tls.Server` leaves the connection open for the program, as Node's does, and an `https.Server` destroys it. The connection it leaves sees the client's close, as Node's: the client's FIN ends the socket, which ends its side and closes, and its RST (`resetAndDestroy()`) is the socket's `ECONNRESET`, so `server.close()` calls back (golden `tls-server-kept-timeout-node22`). What the program writes to it waits and never goes out, as in Node. What the client sends after the timeout is dropped, where Node's handshake goes on with it: a late hello can still connect there, and bytes that aren't one are OpenSSL's error and an alert.
- `new tls.TLSSocket(socket, { isServer: true, key, cert, … })` over an accepted `net.Socket` does the same handshake and emits `'secure'`, as Node's (`requestCert` and `rejectUnauthorized` are off unless given).
- **Per connection** (slicc-kernel 1.152.0, [slicc-kernel#1501](https://github.com/ai-ecoverse/slicc-kernel/issues/1501), [slicc-kernel#1502](https://github.com/ai-ecoverse/slicc-kernel/issues/1502)), as Node's, on the kernel's `select` once the client's hello is in (golden `tls-server-sni-alpn-node22`):
  - `addContext(servername, context)` serves the context of the last name added that matches the client's SNI (with `*` for one label), and the server's own certificate for any other name or none. A key for another certificate is thrown by `addContext`, as in Node.
  - `SNICallback(servername, callback)` is called with the socket as `this` for a client that sends an SNI, and is called back with a `SecureContext` (or its `context`), or none for the server's own. Without one, `addContext`'s contexts are matched. An error goes to `'tlsClientError'` and the connection closes without an alert, as in Node. A server with no certificate of its own serves through it, and refuses a client without an SNI with `ERR_SSL_NO_SUITABLE_SIGNATURE_ALGORITHM`.
  - `ALPNCallback({ servername, protocols })` (`servername` `false` without an SNI) is called before `SNICallback`, for a client that offers ALPN. `undefined` refuses it with `ERR_SSL_NO_APPLICATION_PROTOCOL`, and one the client didn't offer is `ERR_TLS_ALPN_CALLBACK_INVALID_RESULT`. That error, or one it throws, closes the connection without an alert. With `ALPNProtocols` it is `ERR_TLS_ALPN_CALLBACK_WITH_PROTOCOLS`, as in Node.
  - With `requestCert`, Node checks a client certificate against the chosen context's `ca`, and the kernel checks it against the server's own. So a chosen context with the server's `ca` (or, like it, none) serves as in Node. One whose `ca` differs closes the connection with `'tlsClientError'` `ERR_NOT_SUPPORTED`, without an alert, whatever the client sends. A client Node would refuse is refused, and so is one Node would let in. The kernel has no per-context `ca` yet ([slicc-kernel#1537](https://github.com/ai-ecoverse/slicc-kernel/issues/1537)).
  - `new tls.TLSSocket(socket, { isServer: true, SNICallback, ALPNCallback })` does the same. `getCertificate()` is the certificate served.
  - Each context is the kernel's while a handshake uses it (`ctx.net.tlsContext`), one per context at a time however many connections use it. A process holds at most 64: past that, a handshake that needs another is `'tlsClientError'` with the kernel's `EMFILE`.
- **Not there:** there is no session resumption or tickets, and no OCSP.
- **A client's view of a refusal.** A client the server refuses for want of a certificate reads the server's alert, `ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED`, as a Node client does (slicc-kernel 1.151.0, [slicc-kernel#1499](https://github.com/ai-ecoverse/slicc-kernel/issues/1499)). One whose certificate it refuses reads `ERR_SSL_TLSV1_ALERT_UNKNOWN_CA` (alert 48), because the kernel fails the handshake. Node's server completes it and closes without an alert, so a Node client sees the close, or `ECONNRESET` (`socket hang up`) from `https`.
- **The key** goes to the kernel with each handshake, and the kernel wipes its copies. The program's own `key` string or `Buffer` stays in its realm, as in Node, and no error or log carries it.

On any kernel these throw `ERR_NOT_SUPPORTED`:
- `connect()` on a `TLSSocket`, and a `tls.Server`'s handshake over a stream that isn't one of jsh's `net.Socket`s emitted to its `'connection'`: that one gets `'tlsClientError'` with `ERR_NOT_SUPPORTED` and is destroyed.
- `createSecureContext` (and so `createServer`) with key material other than `ca`, `cert` and `key`: `pfx`, `crl`, `dhparam`, a private-key engine or a client-certificate engine. Each one's type is checked first, as Node checks it.
- `createSecurePair`, which is deprecated (DEP0064).

What doesn't need a handshake is Node's:
- `checkServerIdentity`: Node's matching (wildcards, the CN fallback, quoted altnames, IP addresses compared in canonical form), returning `ERR_TLS_CERT_ALTNAME_INVALID` with `reason`, `host` and `cert`, or throwing `ERR_TLS_CERT_ALTNAME_FORMAT`.
- `convertALPNProtocols`, `getCiphers()` (Node 22.22.0's list, from its OpenSSL), `DEFAULT_CIPHERS`, `DEFAULT_ECDH_CURVE`, `DEFAULT_MIN_VERSION`, `DEFAULT_MAX_VERSION` (both follow `--tls-min-v1.x`, `--tls-max-v1.x` and `--tls-cipher-list`), `CLIENT_RENEG_LIMIT` and `CLIENT_RENEG_WINDOW`.
- `createSecureContext` and `SecureContext`, with Node's option checks and errors (`ERR_TLS_INVALID_PROTOCOL_VERSION`, `ERR_TLS_PROTOCOL_VERSION_CONFLICT`, …).
- `TLSSocket` extends `net.Socket`, and `Server` extends `net.Server` (callable without `new`, as in Node), so `instanceof` checks and subclasses work. `new tls.TLSSocket()` without a socket has `encrypted: true` and `authorized: false`, and its session getters answer as Node's do before a handshake (`getPeerCertificate()` is `null`, `exportKeyingMaterial` is `ERR_TLS_INVALID_STATE`). A `tls.Server` keeps its options, contexts (`addContext`) and ticket keys.

**`rootCertificates` is an empty frozen array**, and so are `getCACertificates('bundled')`, `'system'` and `'extra'`. The trust store is the kernel's (or the transport's), not jsh's, so Node's 146 bundled certificates (about 220 KB) would be trust anchors nothing in jsh uses. `setDefaultCACertificates` checks its arguments as Node does and keeps the list as given, which `getCACertificates()` returns; it doesn't change what the kernel trusts.

The golden `tls-node22` checks the export list and these behaviours against Node 22.22.0. `test/integration/tls-kernel.test.mjs` runs the same programs on host Node 22.22.0 and in a kernel with a fake uplink to the same TLS servers (a raw echo, failed verifications, STARTTLS, pg, nodemailer, https-proxy-agent, `https` with an agent; on 1.124.13, client certificates in `tls`, pg and `https`, bad key material, the SNI a server sees, `getCipher()` and `checkServerIdentity`; on 1.125.2, a server's alert and the chain's verdict), and compares their output..

## `http2`

`require('http2')` and `import … from 'node:http2'` load with Node 22.22.0's exports. Packages that require `http2` at load but use it only behind an option load and run over HTTP/1.1. **axios** (unless `httpVersion: 2`), the AWS SDK v3's **@smithy/node-http-handler** (`NodeHttpHandler`), googleapis and superagent are examples. got and fastify also need `dns` at load.

There are no HTTP/2 sessions: h2 and h2c need a frame layer jsh doesn't have. These calls throw `ERR_NOT_SUPPORTED` (`slicc-jsh: '<what>' is not supported yet (…)`) when they're made:
- `http2.connect`, after Node's checks of its arguments (`ERR_HTTP2_UNSUPPORTED_PROTOCOL` for another scheme);
- `listen()` on `createServer`'s and `createSecureServer`'s servers;
- `performServerHandshake`.

What's Node's:
- `constants`, all 240, read-only as in Node.
- `getDefaultSettings()`.
- `getPackedSettings`/`getUnpackedSettings`: Node's checks (`ERR_HTTP2_INVALID_SETTING_VALUE` with `actual`, `min` and `max`), byte order and the `maxHeaderSize` warning. As in Node 22.22.0, `getPackedSettings` returns `undefined` when there are custom settings.
- `sensitiveHeaders`.
- `Http2ServerRequest` (a `Readable`) and `Http2ServerResponse` (a `Stream`), for `instanceof` and subclassing.
- `createServer` (a `net.Server`) and `createSecureServer` (a `tls.Server`, ALPN `h2`), with Node's option checks, `setTimeout` and `updateSettings`.

The golden `http2-node22` checks these against Node 22.22.0.

## `dns`

`require('dns')`, `require('dns/promises')` and their ESM forms load with Node 22.22.0's exports, argument checks and errors. So do the packages that require `dns` at load: **pg**, **mongodb**, **ioredis**, **redis**, **undici**, **nodemailer**, **fastify**, **nats**, **ssh2**, and **got** (which also needs `http2`). `test/integration/dns.test.mjs` loads pg, nodemailer, undici, fastify, nats, ssh2, superagent and googleapis-common (googleapis' client) in a kernel program, and runs got and ioredis.

**`lookup`** (callback and promise forms, `all`, `family`, `order`/`verbatim`, `hints`) is getaddrinfo. An IP literal answers at once.
- jsh asks the kernel's resolver (`ctx.net.resolve`). It answers from `/etc/hosts`, then the kernel's own names, then the uplink, the same answers WASI programs get. A name it doesn't know is `getaddrinfo ENOTFOUND <name>`. When the uplink fails or times out, the kernel ([slicc-kernel#1363](https://github.com/ai-ecoverse/slicc-kernel/issues/1363)) answers `EAI_AGAIN`, and the program gets Node's `getaddrinfo EAI_AGAIN <name>` (`errno` -3001) from `lookup`, and `queryA ETIMEOUT` / `queryAaaa ETIMEOUT` from `resolve4` / `resolve6` (tests `dns` and `dns-eai-again`).
- `net.connect`, `http.request` and `fetch` don't go through `dns.lookup`: a name passed to them is resolved by the kernel, as before.

**`lookupService`** names the kernel's own addresses (`127.0.0.1` and `::1` are `localhost`) and the common TCP services from `/etc/services` (`ssh`, `http`, `https`, …). It gives any other address and port back as numbers.

**Queries** (`resolve*`, `Resolver`): `resolve4` and `resolve6` ask the kernel's resolver (`ttl: true` gives a TTL of 0), and a name it doesn't know is `queryA ENOTFOUND <name>`. There's no DNS transport for the other record types, so such a query finds no nameserver and fails as c-ares does then, with `query<Type> ECONNREFUSED <name>` (for example `queryMx` or `querySrv`; `mongodb+srv://` needs SRV records). `reverse` names the kernel's own addresses. `getServers()` is empty until `setServers` (checked as Node does) sets a list. `cancel()` ends the pending queries with `ECANCELLED`.

`ADDRCONFIG`, `ALL` and `V4MAPPED` have Linux's values. `getDefaultResultOrder` follows `--dns-result-order`. `util.promisify(dns.lookup)` and `promisify(dns.lookupService)` resolve to Node's `{ address, family }` and `{ hostname, service }`.

The golden `dns-node22` checks the surface against Node 22.22.0, and `test/integration/dns.test.mjs` checks the kernel's answers.

## `fetch` and `WebSocket`

`globalThis.fetch` and `globalThis.WebSocket` run on the kernel's `ctx.fetch` and `ctx.websocket`. A request in flight keeps the program alive, and so does reading its body. `new WebSocket` checks its URL and protocols as Node 22's does: `http:` and `https:` become `ws:` and `wss:`, another scheme, a fragment, a duplicate or a non-token protocol is a `SyntaxError` `DOMException`, and `.url` is the parsed URL.

**Loopback.** As with Node on a machine, a loopback URL reaches a server of *this* kernel. The loopback names are `127.0.0.0/8`, `::1`, `0.0.0.0`, `localhost`, `*.localhost` and `<port>.kernel.localhost`. jsh does the HTTP over the kernel's sockets on every kernel. A `ws:` URL goes to the kernel's own loopback `ctx.websocket`, which answers as undici does ([slicc-kernel#822](https://github.com/ai-ecoverse/slicc-kernel/issues/822)), and `new WebSocket(process.env.SLICC_CDP_URL)` reaches the kernel's CDP facade on 127.0.0.1:9222, and the loopback WebSocket holds the server to RFC 6455 as undici does.
- A loopback redirect to another origin drops `authorization`, `proxy-authorization`, `cookie` and `host`.
- A body is decoded as undici decodes it: `gzip`, `x-gzip`, `deflate` and `br` (`br` through zlib, so one cut short ends without an error and a corrupt one fails the read with `TypeError: terminated`), a list of them last first, none if one is unknown (`zstd` too, as in Node 22), and more than five is `fetch failed`. The request asks for `gzip, deflate`, as undici does for `http:`.
- `host.slicc.internal` (and `10.0.2.2`) reach the real machine's loopback, through the kernel's proxy.

**Why not the kernel's loopback `fetch`.** The kernel's own loopback `ctx.fetch` (added in [slicc-kernel#510](https://github.com/ai-ecoverse/slicc-kernel/issues/510)) still differs from Node's undici in two ways, so jsh keeps its own:
- the request on the wire has none of undici's default headers (`accept`, `accept-language`, `sec-fetch-mode`, `user-agent`, `accept-encoding`); the kernel declined adding them ([slicc-kernel#599](https://github.com/ai-ecoverse/slicc-kernel/issues/599));
- it is sent with `connection: close`, where undici keeps the connection alive.

A third difference is fixed from slicc-kernel 1.110.5: before that, an abort no longer reached a body being read once a garbage collection had taken the request ([slicc-kernel#888](https://github.com/ai-ecoverse/slicc-kernel/issues/888)).

**A refused `WebSocket` connect** (on the Node entry): jsh emits an `error` event and no `close`, and `readyState` stays `CONNECTING`, as Node 22's undici does. The kernel's `cause.code` is passed through on `event.error.cause` (`ECONNREFUSED`, `EAI_NONAME`, `EHOSTUNREACH`/`ENETUNREACH`, `ETIMEDOUT`, `EPROTO`). Node's own `ErrorEvent.error` has no `.code` or `.cause`, so jsh doesn't add one to the event.

## `crypto`

Node 22's own JS layer (`lib/internal/crypto/{hash,cipher,keys,pbkdf2,hkdf,scrypt,random}.js`, ported) over pure-JS primitives: @noble/hashes for digests, HMAC, PBKDF2, HKDF and scrypt; browserify-aes and browserify-des for block ciphers. They sit in a minified vendor bundle that the first `require('crypto')` evaluates. Random numbers, `webcrypto` and `subtle` are the platform's WebCrypto.

**Available:**
- `createHash`/`hash` for md5, sha1, sha2, sha3, shake, ripemd160, blake2, sm3 and md5-sha1, under OpenSSL's names and aliases;
- `createHmac`, `pbkdf2`, `hkdf` and `scrypt`, each sync and async;
- `createCipheriv`/`createDecipheriv` for AES ECB/CBC/CFB/CFB8/CFB1/OFB/CTR/GCM and 3DES;
- secret `KeyObject`s (`createSecretKey`, `generateKey`);
- the `random*` family, `randomUUID`, `getRandomValues`, `timingSafeEqual`, `getCiphers`/`getCipherInfo`/`getHashes`, and `constants`.

Outputs and errors match Node 22.22.0 (golden `crypto-node22`), Node's quirks included, such as "Deriving bits failed" for a zero-length PBKDF2 or HKDF key.

**As in Node 22:** md4, mdc2 and whirlpool fail with `ERR_OSSL_EVP_UNSUPPORTED`. DES (single), Blowfish and the other ciphers of OpenSSL's legacy provider fail as `unsupported`.

**Not available:** asymmetric keys, sign/verify, DH/ECDH, RSA encryption, primes, X509, the CCM/OCB/XTS/ChaCha20/wrap/ARIA/Camellia/SM4 ciphers, and FIPS mode. They throw `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`; `crypto.subtle` covers much of it. The callback forms (`generateKeyPair`, `generatePrime`, `checkPrime`) check their callback as Node does and pass that error to it.

## `zlib`

browserify-zlib 0.2.0 (a port of Node's own `zlib.js`) over pako 1.0.11. The vendor bundle is minified, and the first `require('zlib')` evaluates it. It is patched to Node 22:
- option validation and its errors;
- ArrayBuffer and TypedArray input;
- `{ info: true }`, `destroy`/`close`, `params`, and raw-inflate dictionaries;
- `constants`/`codes` from Node 22, the legacy top-level constants, and `crc32`.

Deflate output is byte-identical to Node's (golden `zlib-node22`).

**Brotli decompression.** `brotliDecompress`, `brotliDecompressSync`, `createBrotliDecompress` and `BrotliDecompress` are Node 22's own `zlib.js` code for them over a decoder ported from the one Node links (Google's C decoder, brotli 1.1.0, in `src/brotli`), loaded on the first Brotli stream. A stream decodes as in Node:
- the same output from each write, the same input consumed (`bytesWritten`), and the same error at the same byte: `Decompression failed` with Brotli's code (`ERR__ERROR_FORMAT_PADDING_2`, …) as `code` and its number as `errno`, or `unexpected end of file` (`Z_BUF_ERROR`) for a stream cut short;
- `params` (`BROTLI_DECODER_PARAM_LARGE_WINDOW`, `BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION`), `flush`, `finishFlush`, `chunkSize`, `maxOutputLength`, `info` and `rejectGarbageAfterEnd`, validated with Node's errors;
- `flush()`, `reset()`, `close()` and `params()`, Node's quirks included.

Golden `zlib-brotli-node22` decodes streams Node 22's encoder made, across qualities and windows, in pieces down to 1 byte, corrupt and truncated. The decoder decodes Brotli's static dictionary (122,784 bytes) from its own Brotli encoding, on the first stream that uses it. In a bundle it is about 35 KB of code and 69 KB of base64 for the dictionary. It decodes at roughly 90–700 MB/s on Node, depending on the data; the native decoder is several times faster.

**Zstd decompression.** `zstdDecompress`, `zstdDecompressSync`, `createZstdDecompress` and `ZstdDecompress` are Node 22's own `zlib.js` code for them over a decoder ported from the one Node links (Facebook's C decoder, zstd 1.5.7, in `src/zstd`), loaded on the first zstd stream. A stream decodes as in Node:
- the same output from each write, the same input consumed, and the same error at the same byte: zstd's message (`Data corruption detected`, …) with `ZSTD_error_*` as `code` and zstd's number as `errno`;
- as in Node, input cut short is no error (the output so far), and the stream ends after the first frame, a skippable frame counting as one;
- `params` (`ZSTD_d_windowLogMax`), `dictionary` (raw content or zstd's format, `Failed to load zstd dictionary`), `pledgedSrcSize`, `flush`, `finishFlush`, `chunkSize`, `maxOutputLength`, `info` and `rejectGarbageAfterEnd`, validated with Node's errors;
- `flush()`, `reset()` (which drops the dictionary and the parameters, as in Node) and `close()`.

Golden `zlib-zstd-node22` decodes frames Node 22's encoder made, across levels and windows, with checksums and dictionaries, in pieces down to 1 byte, corrupt and truncated; a differential fuzz against Node 22's own decoder found no difference in 16,000 cases. In a bundle the decoder is about 46 KB (17 KB gzipped). It decodes at roughly 400–500 MB/s on Node for data with few long matches, and faster for repetitive data; the native decoder is about five times faster on the former.

`fetch` doesn't decode `zstd`, as undici in Node 22 doesn't: it doesn't ask for it, and a `zstd` body comes as it was sent.

**Brotli and Zstd compression.** `brotliCompress`, `brotliCompressSync`, `createBrotliCompress`, `BrotliCompress`, `zstdCompress`, `zstdCompressSync`, `createZstdCompress` and `ZstdCompress` are Node 22's own `zlib.js` code for them over the C libraries Node links, compiled to WebAssembly: Google's encoder (brotli 1.1.0, `src/brotli/encoder.wasm`) and Facebook's compressor (zstd 1.5.7, `src/zstd/compress.wasm`), built by `scripts/wasm/build.sh` from the release tarballs with zig 0.16 and dlmalloc. A stream compresses as in Node:
- to the same bytes, write for write and flush for flush, at every quality, level, window and parameter;
- `params` (every `BROTLI_PARAM_*` and `ZSTD_c_*`, including Brotli's large window, zstd's long distance matching and its multithreaded jobs, `nbWorkers`), `dictionary` and `pledgedSrcSize` for zstd, `flush`, `finishFlush`, `chunkSize`, `maxOutputLength` and `info`, validated with Node's errors (`ERR_BROTLI_INVALID_PARAM`, `ERR_ZSTD_INVALID_PARAM`, `Setting parameter failed`, `pledgedSrcSize may not be negative`, …);
- zstd's errors with Node's `ZSTD_error_*` code and zstd's number (`ZSTD_error_srcSize_wrong` for a stream that doesn't match its `pledgedSrcSize`), and Brotli's `Compression failed` (`ERR_BROTLI_COMPRESSION_FAILED`);
- `flush()`, `reset()` (which drops the parameters, and zstd's dictionary, as in Node) and `close()`.

Goldens `zlib-brotli-compress-node22` and `zlib-zstd-compress-node22` compress across qualities, levels, windows and parameters, in the sync, callback, promisify and stream forms, and decode what Node 22 compressed and what jsh compressed; integration `zlib-compress.test.mjs` has got decode a server's streamed and flushed `br` and `zstd` responses, the bytes Node 22 sends.

The WebAssembly (546 KB for Brotli, 369 KB for zstd; 242 KB and 95 KB gzipped) isn't in the bundle: it is read from the package's `dist/vendor/` and compiled on the first compressing stream (about 15 ms for Brotli, which also decodes the static dictionary it shares with the decoder, and 2–3 ms for zstd), so a process that doesn't compress starts as before. On 1 MB of mixed text, JSON and random bytes, jsh compresses 1.1–2.2× slower than Node 22 (Brotli quality 11 in 1.04 s against 0.98 s, quality 5 in 33 ms against 15 ms; zstd level 3 in 3.9 ms against 2.7 ms, level 19 in 227 ms against 181 ms).

Where it differs:
- the work is done when it's written, on the JavaScript thread, and its callback comes on a later turn of the loop in the order of the writes. On Node it runs on the thread pool, and the callbacks of work running at once come in the order it finishes: for `brotliCompress('x', cb)` then `zstdCompress('x', cb)`, macOS calls Brotli's first most of the time and Linux zstd's;
- the WebAssembly is 32-bit: a zstd `windowLog` of 31 or a `chainLog` of 30 is `Setting parameter failed`, where Node takes it, a `jobSize` over 512 MB is taken as 512 MB (Node: 1 GB), and a Brotli window of 2**30 (`BROTLI_PARAM_LGWIN` 30, large window) can't get its 2 GB ring buffer: `Compression failed`;
- zstd's multithreaded jobs (`nbWorkers` 1 and up) run one after the other, each at once, and give Node's bytes. Node's own async forms lose output with them (its stream ends before the workers do); jsh's are whole, as Node's sync form is.

## Streams and `Buffer`

**Streams.** `stream` and `stream/promises` are readable-stream 4, loaded on first use. `Readable`/`Writable`/`Duplex` `fromWeb`/`toWeb` are Node's adapters. `stream/web` is the platform's WHATWG streams. `stream/consumers` is Node's own. `string_decoder` is the npm `string_decoder`, Node's own code; it accepts any TypedArray. Every stream and `string_decoder` share jsh's `Buffer` class.

**`Buffer`.**
- Buffer views share memory with their source, as in Node.
- `Buffer.allocUnsafe` and `allocUnsafeSlow` zero-fill, and `Buffer.poolSize` is `0` (no pool).
- Encodings are as in Node 22's `lib/buffer.js`. `from`, `toString`, `write`, `fill` and `indexOf`/`lastIndexOf`/`includes` throw `ERR_UNKNOWN_ENCODING` for an encoding Node doesn't know; `byteLength` counts it as UTF-8, as Node does. base64 decoding is forgiving, `ascii` drops the high bit, and `write` never writes part of a character. A string that is too long is `ERR_STRING_TOO_LONG`.
- `Buffer`'s static methods (`from`, `alloc`, `concat`, `byteLength`, `isBuffer`, …) are own enumerable properties, as in Node, so **safer-buffer**'s copy of `Buffer` has them (golden `buffer-statics-enumerable-node22`). That's what iconv-lite, raw-body and body-parser use.
- `require('buffer')` has Node 22's exports: `transcode`, `isUtf8`, `isAscii`, `constants`, `kMaxLength`, `Blob`, `File`, ….

## `events`

Node v22.22.0's own `lib/events.js`. It is the `EventEmitter` of `require('events')` and of every emitter in the runtime: `process`, streams (so `new Stream()` is an EventEmitter), child processes, servers and agents. That brings `newListener`/`removeListener`, `prependListener`, `errorMonitor`, `captureRejections`, `setMaxListeners` and the `MaxListenersExceededWarning`, `events.once`/`events.on` with `AbortSignal`, `getEventListeners`, `listenerCount`, and `EventEmitter.call(this)` for old-style subclasses.

**Differs:** the platform's own `EventTarget` and `AbortSignal` have none of Node's internals, so `getEventListeners` and `getMaxListeners` don't accept them.

## `readline` and the REPL

**`readline`** and **`readline/promises`** are Node v22.22.0's own `lib/readline`. That covers `createInterface` over any stream, `question`, `for await (const line of rl)`, `emitKeypressEvents`, the cursor helpers, and on a terminal raw-mode line editing with history, completion, `^C` (`'SIGINT'`) and `^D`. The `readline-node22` golden matches Node's bytes, escape sequences included.

**The REPL** starts for `node` with no script, `-e` or `-p` and a terminal on stdin, or with `-i`. It is Node v22.22.0's own (`lib/repl.js`, `lib/internal/repl.js`, `lib/internal/repl/{utils,history,await}.js`, `lib/domain.js`, and acorn-walk). That brings:
- the banner, and results printed with `inspect` (coloured on a terminal);
- multi-line input, `_` and `_error`, top-level `await`, Tab completion;
- `.break`, `.clear`, `.editor`, `.exit`, `.help`, `.load`, `.save`, `^C` and `^D`;
- `NODE_REPL_MODE`, and history in `~/.node_repl_history` (`NODE_REPL_HISTORY`, `NODE_REPL_HISTORY_SIZE`).

The builtins are globals there, as in Node. An error thrown later, from a timer or a rejection nobody handles, is reported as `Uncaught …` and the REPL goes on, as Node's domains make it. With a pipe on stdin, plain `node` runs the piped text as a script. `repl.start()` runs a REPL over any streams.

**Differs:**
- There is no inspector, so no previews as you type and no `^C` out of a running loop.
- Under the Node-hosted kernel, `module` and `require` are locked on `globalThis`, so the REPL's own are in the scope its lines run in instead.

## `util`, `console`, `os`, `path`, `url`, `querystring`, `punycode`

**`util` and `console`** are Node v22.22.0's own `lib/util.js` and console (`lib/internal/console/{constructor,global}.js`, `internal/cli_table`), with `internal/util/{types,debuglog,colors,diff,comparisons,parse_args}` and `internal/mime`. That brings `parseArgs`, `styleText`, `MIMEType`, `parseEnv`, `getCallSites`, `getSystemErrorName`/`getSystemErrorMap`/`getSystemErrorMessage` (libuv's errors with Linux numbers), the full `util.types`, `isDeepStrictEqual` (Node's comparisons), `debuglog` (`NODE_DEBUG`), `diff`, and the deprecated `util.is*`. The console is all there: `Console`, `timeLog`, and colours as Node's `shouldColorize` decides them. The global console publishes to `diagnostics_channel` as Node's does.
- `util.inspect` is node-inspect-extracted, with Node 22's symbol-key and `byteLength` output. A Proxy shows as its target unless `showProxy` is on, as in Node 22 (golden `util-inspect-proxy-node22`).
- `util.inspect` (and so `console.log`) shows a promise's state as Node 22 does: `Promise { 1 }`, `Promise { <rejected> 'x' }` and `Promise { <pending> }`, read through the kernel's `ctx.sync.promiseState` (slicc-kernel 1.159.0, ai-ecoverse/slicc-kernel#1531). Reading it doesn't handle a rejection, so `'unhandledRejection'` comes as in Node (golden `util-inspect-promise-state-node22`). Where the kernel can't tell, every promise shows `<pending>`: in a browser, and on the Node host once a program has changed `Object.prototype`, put a `toJSON` on a built-in prototype or made the global non-extensible.
- The inspector-only `console.profile`/`profileEnd`/`timeStamp`/`context`/`createTask` do nothing.

**`path`, `url`, `querystring`, `punycode`, `os`** are Node v22.22.0's own files:
- `path`, `win32` included. `matchesGlob` runs on the npm minimatch.
- `url`: legacy `parse`/`format`/`resolve`, `fileURLToPath`/`pathToFileURL` with `windows`, `domainToASCII`/`domainToUnicode`, `urlToHttpOptions`. The WHATWG `URL` is the platform's.
- `os` reports the kernel:
  - `os.userInfo()` is the kernel's `/etc/passwd` entry;
  - `os.constants` holds Linux's values;
  - `os.networkInterfaces()` lists the kernel's loopback;
  - `os.availableParallelism()` and `os.cpus()` come from `navigator.hardwareConcurrency`.

`sys` is `util` (with DEP0025), from Node's `lib/sys.js`.

## `vm`

Scripts run in the program's own realm, which is the only one a process has here.

- `runInThisContext` keeps a script's top-level declarations for the next script, as V8 does. On the Node host it runs the script through the kernel's `ctx.sync.runScript`, so `let`, `const` and `class` are in the global lexical scope, a `const` is read-only and a second `let` of a name is a SyntaxError. In a browser, in the REPL, with `displayErrors: false`, and for a script whose top-level `let`, `const` or `class` takes the name of a global, top-level `let`/`const`/`class` become `var` instead, so a `const` isn't read-only there and a name can be declared twice.
- A context (`createContext`, `runInContext`, `runInNewContext`) is the object in front of the ECMAScript globals: the names a script declares or assigns go on it. Its top-level `this` and `globalThis` are the context's global, as in Node. That global isn't the object you passed: it reads and writes that object's properties, and the ECMAScript builtins show through it. The context isn't a separate realm, though, so its `Object` is the program's, and a sloppy function called without a receiver gets the program's global as `this`, not the context's.
- A SyntaxError is V8's, with the arrow under the token. `displayErrors` puts the arrow at the throw site, and a script's frames are named by its `filename`.
- `import()` goes to `importModuleDynamically`, and `vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER` uses the program's loader. Without one, `import()` fails with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`. A callback function needs `--experimental-vm-modules`, as in Node.
- `compileFunction` is there. Cached data is accepted and never used.

**Not available:** `timeout` and `breakOnSigint` can't interrupt a running script. `vm.Module` isn't there. `measureMemory` rejects with `ERR_NOT_SUPPORTED`.

## `async_hooks`, `domain`, `perf_hooks`, `v8` and diagnostics

**`inspector`** and **`inspector/promises`** load with Node 22.22.0's exports, so playwright-core and @vitest/coverage-v8, which require them at load, get past them. The kernel has no V8 inspector for a program, so jsh behaves as a Node whose inspector isn't active:
- `url()` is `undefined`, `close()` does nothing, and `waitForDebugger()` is `ERR_INSPECTOR_NOT_ACTIVE`.
- An unconnected `Session`'s `post` is `ERR_INSPECTOR_NOT_CONNECTED` (a rejection from `inspector/promises`), and `connectToMainThread` is `ERR_INSPECTOR_NOT_WORKER`.
- `console`, `Network` and `NetworkResources` check their arguments and reach no frontend.
- What would start an inspector, `open()` and `Session#connect()`, throws `ERR_NOT_SUPPORTED` when it's called. That means a CPU profile or coverage through a `Session` isn't available (golden `inspector-node22`).

**`net`** also has Node's happy-eyeballs defaults (`get`/`setDefaultAutoSelectFamily`, `get`/`setDefaultAutoSelectFamilyAttemptTimeout`, golden `net-autoselect-family-node22`). The kernel's loopback is IPv4 only, so they choose nothing.

**`async_hooks`** has `AsyncResource` (including `bind` and `runInAsyncScope`, under which `executionAsyncId()` is the resource's), `createHook` (its hooks never run), `executionAsyncId`/`triggerAsyncId` and `asyncWrapProviders`. That's enough for `events.EventEmitterAsyncResource`.

**`AsyncLocalStorage`** is Node 22's: `run`, `exit`, `enterWith`, `getStore`, `disable`, and the static `bind` and `snapshot`. Its store goes where jsh can carry it, as in Node:
- the synchronous call of `run`;
- `process.nextTick`, `setTimeout`, `setInterval`, `setImmediate` and `queueMicrotask` callbacks;
- `.then`, `.catch` and `.finally` reactions, in the context they were registered in;
- `AsyncResource`: `runInAsyncScope`, `bind`, `AsyncLocalStorage.bind` and `snapshot`;
- the callbacks of the runtime's own I/O, in the context Node gives them:
  - a `net` server's `'connection'`: the `listen()`'s store. Its accepted socket's own events get none, as in Node;
  - a client socket's `'connect'`, `'data'`, `'end'` and `'close'` (`net`, `tls`): the `connect()`'s store;
  - an `http` server's `'request'`, the request's `'data'` and `'end'`, and the next request on a kept-alive connection: the `listen()`'s store;
  - an `http` client request's `'response'` and its body: the `request()`'s store, even on a pooled socket;
  - a child's `stdout` and `stderr`: the `spawn()`'s store.

EventEmitter listeners run in the context of the code that emits, as in Node. `enterWith` in one of those callbacks works as in Node: its store reaches what the callback schedules, and the later callbacks of the same socket or connection. So a kept-alive connection's next `'request'` sees the store the previous one entered, as in Node. The goldens `async-local-storage-node22` and `async-local-storage-await-node22` check these against Node 22.22.0.

**A native `await` keeps the store on the Node entry from slicc-kernel 1.143.0.** That kernel gives each program `ctx.asyncContext`, an `AsyncLocalStorage` of the host, and jsh keeps its store there from the first `AsyncLocalStorage` on. Then the store follows a native `await` as in Node, `enterWith` works after one, and runs interleaving across `await`s each see their own store. A `.then` or `queueMicrotask` after an `await` keeps it too, and so does `exit`, which takes the store away from what it schedules as in Node. The golden `async-local-storage-await-node22` checks this against Node 22.22.0, and `test/integration/async-local-storage.test.mjs` checks both sides of the 1.143.0 line.
- On a host Node 22 that `AsyncLocalStorage` turns on the host's promise hooks while the program has one, so an `await` costs more: 100k `await`s take about 17 ms instead of 5 ms. Host Node 24 and later don't pay that.

**The gap, on the browser entry and below slicc-kernel 1.143.0: a native `await` continuation loses the store.** The engine resumes it, and no JavaScript in the program's realm can see that: the browser's V8 has no promise hooks and no `AsyncContext` for a page or worker. The code after an `await` inside `run()` sees the store that's current outside every run, usually `undefined`. It **never sees another run's store**, so request-scoped code fails visibly (a missing store), never with the wrong identity. A callback of other runtime I/O, such as a WebSocket's `'message'`, behaves the same way.
- Register a `.then()` inside the run, or wrap the callback with `AsyncLocalStorage.bind()`/`snapshot()`, to keep the store.
- `enterWith` where jsh can't bound it (after a native `await`, or in such a callback) throws `ERR_NOT_SUPPORTED`. Otherwise its store would reach unrelated code; use `run()` there. In the main module, `-e` and the callbacks jsh enters, `enterWith` works as in Node.
- No warning is printed, so output stays Node's.
- Below 1.143.0 `test/integration/async-local-storage.test.mjs` checks the gap. That includes two runs interleaving across `await`s, where neither ever sees the other's store.

**`domain`** is Node's own `lib/domain.js`. It follows a domain into the ticks, timers and immediates queued inside it, which is where Node's async hooks take it. A throw there is the domain's `'error'`, and so is an emitter's `'error'`. Promise jobs are the gap: the runtime can't see them, so a rejection isn't routed to a domain.

**`diagnostics_channel`** is Node's own, `tracingChannel` included.

**`perf_hooks`:**
- `performance` and the `Performance*` classes are the program's own, and `constants` are Node's.
- `createHistogram` and `monitorEventLoopDelay` are Node's histograms written in JS. Values are counted exactly, so above 2047 a percentile can differ from Node's 3-significant-figure HDR buckets.

**`v8`:** heap and code statistics (approximate), `cachedDataVersionTag`, `setFlagsFromString` (changes nothing), `startupSnapshot` (never building one), `isStringOneByteRepresentation`, and the coverage no-ops. Heap snapshots and `queryObjects` need V8's own bindings: they throw `ERR_NOT_SUPPORTED`.

**`v8.serialize`/`deserialize`, `Serializer`/`Deserializer` and `DefaultSerializer`/`DefaultDeserializer`** write and read V8's ValueSerializer format, version 15, byte for byte (golden `v8-serdes-node22`). A payload written by Node reads here, and the other way round. This covers:
- every tag, Node's own handling of Buffers and typed arrays, transfers, `SharedArrayBuffer` ids, and the delegate hooks (`_writeHostObject`, `_readHostObject`, `_getDataCloneError`, `_getSharedArrayBufferId`);
- V8's `could not be cloned` messages, its deserialization errors, and the versions Node reads (13 to 15).

Where V8's bytes depend on how it lays an object out in memory, which a program can't see, jsh writes what a literal gives:
- An integral number is an int32 (`I`). V8 writes a double for a value it happens to hold as a heap number, such as an object field that held a fraction before.
- An array with no holes is dense. V8 writes `new Array(n)` that was filled in afterwards as sparse.

Either way the value reads back the same.

## Modules that are not available

| Module | What `require` does |
|---|---|
| `dgram` | throws `ERR_NOT_SUPPORTED` |
| `test`, `sqlite`, `sea` | throws `ERR_UNKNOWN_BUILTIN_MODULE` |

**`wasi`** is Node 22.22.0's own `lib/wasi.js`. Its binding is the kernel's WASI host (`ctx.sync.wasi.create`, [slicc-kernel#1111](https://github.com/ai-ecoverse/slicc-kernel/issues/1111)): an in-process preview1 instance with its own guest fd table, as Node's uvwasi is (golden `wasi-node22`). That covers:
- the options and their errors, the 46 preview1 imports, `getImportObject` for `preview1` and `unstable`;
- `start` and `initialize` with their checks, and `proc_exit`, which `start` returns with `returnOnExit` and which otherwise ends the program at once, with no `'exit'` event;
- preopens, which are kernel paths;
- napi-rs's `wasm32-wasi` fallbacks (unrs-resolver, rolldown, swc) need this.

Not as in Node: the stdio fds are the program's kernel fds. 0, 1, 2 and a device that `fs` opened work, but a file that `fs` opened has no kernel fd (`fs` reads and writes it by its path), so it can't be `stdin`, `stdout` or `stderr`: `new WASI` throws `ERR_NOT_SUPPORTED`.

**`cluster`** is Node 22.22.0's: the primary (`isPrimary`, `workers`, `settings`, `setupPrimary`/`setupMaster` with its `'setup'` event, `schedulingPolicy`, `disconnect`, the `Worker` class) and, on a kernel with fork's IPC channel ([slicc-kernel#1093](https://github.com/ai-ecoverse/slicc-kernel/issues/1093)), its workers (golden `cluster-fork-node22`). The primary alone is enough for prom-client's `AggregatorRegistry` (golden `cluster-trace-events-node22`).
- `cluster.fork(env)` is a `child_process.fork` of `settings.exec` with `NODE_UNIQUE_ID`. In it, `cluster.isWorker` and `cluster.worker` are the worker's.
- The two sides talk in Node's internal `NODE_CLUSTER` messages, with Node's events and states on the cluster and the workers: `'fork'`, `'online'`, `'listening'`, `'message'`, `'disconnect'` and `'exit'`. `disconnect()`, `exitedAfterDisconnect`, `kill()`, `isDead()` and `cluster.disconnect()` work as in Node.
- A worker's server (`net`, `http`) listens through the primary, as in Node: the primary listens where the worker asked, and every worker asking for that address shares it. Under `SCHED_RR` (the default) the primary accepts and hands each connection to the next free worker; under `SCHED_NONE` it hands the listening socket to each worker, which accepts on it. Either way the handle goes over the IPC channel, and the worker's socket sees the client as its peer (golden `cluster-handles-node22`).
- Not as in Node: on a kernel without descriptor passing (the browser's), each worker listens on a loopback port of its own, and the primary joins each connection to it. The worker's socket sees the primary as its peer there, and `SCHED_NONE` is round robin too.

**`trace_events`** is Node's: `createTracing` and its checks, `Tracing` objects (`enable`, `disable`, `enabled`, `categories`, and their inspect form), and `getEnabledCategories()` as the agent's sorted set (with `--trace-event-categories` or `--trace-events-enabled`). It also gives Node's warning past 10 enabled objects. `--trace-event-categories`, `--trace-event-file-pattern` and `--trace-events-enabled` are taken on the command line and in `NODE_OPTIONS` as Node parses them, with its errors (golden `trace-event-flags-node22`). There's no trace agent, so no trace file is written, whatever the categories or the file pattern: the program runs as under Node, without the `node_trace.*.log` Node writes.

**`worker_threads`** has Node 22.22.0's `Worker` on a kernel with JS threads ([slicc-kernel#1094](https://github.com/ai-ecoverse/slicc-kernel/issues/1094)), golden `worker-threads-node22`.

How a worker runs:
- It is a thread of this process, with the same pid, running jsh with the worker's own globals and module graph.
- Its entry can be a file, an ES module, a `data:` or `file:` URL (as a `URL` object; a string of one is `ERR_WORKER_PATH`, as in Node), or `eval` code (`[worker eval]`). A `file:` URL's query and fragment are dropped, as Node 22 drops them.
- It gets `workerData` and its `transferList`, `argv`, `execArgv`, a copy of `env` (or the given object), the parent's environment data, `parentPort`, `threadId` (counted per process from 1, nested workers included), `threadName` and `resourceLimits`. `workerData` and the environment data are cloned in the constructor, so what can't be is its `DataCloneError`.
- Its `NODE_OPTIONS` are its own `env`'s when one is given, else the parent's as it started (preloads included). The constructor refuses, with Node's `ERR_WORKER_INVALID_EXEC_ARGV` and messages, what a worker can't take: per-process options (`--title`, `--report-*`, `--trace-sigint`, …) in either, V8's (`--max-old-space-size`, `--stack-trace-limit`) and `-v`/`-h` in `execArgv`, and a flag missing its value. `-e`, `-p`, `--check` and `-i` in `execArgv` are kept in its `process.execArgv` but don't change what it runs.
- `'online'`, `'message'`, `'error'` (its uncaught exception, as the thrown value) and `'exit'` come in Node's order. What it posts or prints before it exits comes before `'exit'`.
- `process.exit(n)` ends the worker with `n`, an uncaught error with 1, and `terminate()` with 1. A `terminate()` in the turn that made the worker, before its thread is up, ends it with 0 and nothing of the worker's comes, not even `'online'`, as in Node. Once the worker has exited, `terminate()` resolves `undefined`.
- Its stdout and stderr go to the parent's own unless `stdout`/`stderr` is set, in which case they are `worker.stdout`/`worker.stderr`. `stdin: true` gives `worker.stdin`.
- `ref()` and `unref()` decide whether it holds the parent. `terminate()` refs it, as Node's does, so the parent waits for its `'exit'` even when it was unref'd; tinypool's `destroy()` depends on that.
- `process.chdir`, `abort`, the `set*id`/`*groups` calls and setting `umask` throw `ERR_WORKER_UNSUPPORTED_OPERATION`.

How ports cross between threads:
- A message is the platform's structured clone. An `ArrayBuffer` in the transfer list is detached, a `SharedArrayBuffer` is shared (`Atomics.wait`/`notify` work across threads), and a `MessagePort` moves with the messages waiting in it.
- Each direction also has a mailbox in shared memory. So `receiveMessageOnPort()` has a message as soon as it is posted, even in a thread blocked in `Atomics.wait`; piscina's and tinypool's atomics loops depend on that.
- A message goes the platform's way instead when it transfers ports or streams, carries what the platform shares or clones itself (a `SharedArrayBuffer`, a `Blob`, a `WebAssembly.Module`), or doesn't fit the mailbox. `receiveMessageOnPort()` can't return it until the receiving thread is back in its event loop, but it still comes in order. Either way its getters are read once.

The real piscina 5 (in each of its `atomics` modes) and tinypool 1 run on it, and so does eslint 9's `--concurrency`.

Not as in Node:
- `resourceLimits` is reported but not enforced. A worker that runs out of memory ends with `ERR_WORKER_OUT_OF_MEMORY`. A worker whose thread crashes below the program (the kernel's exit code 257) ends with an `'error'`, `ERR_WORKER_CRASHED`, which is jsh's own (Node has no such end), and `'exit'` 1. A `terminate()` is never an error.
- `env: SHARE_ENV` gives the worker a copy of the environment, not a shared one.
- `postMessageToThread`, `getHeapSnapshot` and `BroadcastChannel` between threads aren't there yet. A worker's `performance.eventLoopUtilization()` is zeros.

**`MessageChannel` and `MessagePort`** are Node 22's, within one program, and are also the globals:
- A message is a structured clone (an `ArrayBuffer` in the transfer list is transferred). A `MessagePort` in the transfer list moves: the receiver gets a new port on the same channel, in `ports`, and the one sent is detached, as in Node. A port in the message but not in the list, one listed twice, the sender itself, or one already moved or closed by the program is Node's `DataCloneError`. So is an object marked with `markAsUncloneable` (an ordinary object or an Error; an array, a `Map` or a buffer still goes), or a `MessageEvent`, which Node marks, anywhere in a message posted to a port or a worker, or in `workerData`. Its `MessageEvent` comes on a later turn.
- Not as in Node: the global `structuredClone` is the platform's, not jsh's, so it clones a marked object, or a `MessageEvent`, as it would any other (`{}` for an event), where Node's throws `DataCloneError`. A `BroadcastChannel` message is cloned the same way (see below).
- The first `'message'` listener (`onmessage`, `on()`, `addEventListener()`) starts the port and refs it; until then messages wait, and `receiveMessageOnPort` takes them synchronously. A started port with a listener keeps the program alive until it's closed or `unref()`'d, as in Node.
- `close()` closes both ends: what was posted before is delivered, then each end gets `'close'`. A port that hasn't started keeps what it holds, for `receiveMessageOnPort()` or a later listener, and gets `'close'` once that is taken. A post to a closed port is still cloned, its transfers moved, then dropped. `new MessagePort()` is `ERR_CONSTRUCT_CALL_INVALID`.
- A port is a NodeEventTarget: `on`, `once`, `off`, `emit` and the rest, where a `'message'` listener gets the data.

**Order of port messages.** BroadcastChannel and MessageChannel share Node's order. In one turn (Node's poll phase), each port, in the order the ports were made, takes its messages one per task, with a handler's ticks and microtasks run before the next. The turn comes before the program's immediates (Node's check phase) and after a timer that was already due when the posting task ended, its microtasks included: from the main script or an immediate, a timer that came due during a long microtask after the posts runs first. Posted from a timer, the turn comes in the same iteration, before a timer that wasn't due when that timer ran. A port the turn has yet to reach takes a message posted during it, and one it has passed takes it on the next turn. A message posted from an immediate waits for the immediates already queued, and those queued after its check phase began wait for its turn. Not as in Node: jsh finds the end of the posting task's microtasks by watching the clock, so long work at the end of a chain of four or more quick microtasks, each queuing the next, counts as after the turn's start. A post from a timer's microtasks, however deep they nest, is the timer's, as in Node (golden `message-channel-timer-nested-microtask-node22`).

**`BroadcastChannel`** is Node 22's, within one program:
- Not as in Node: a message is the platform's structured clone, unchecked, so a marked object (`markAsUncloneable`), a `MessageEvent` or a jsh `MessagePort` in it goes as a plain object, where Node's is a `DataCloneError`. (Checking each message would make a post of a large one about 3x slower.)
- Channels of one name get each other's messages: a structured clone, delivered as a `MessageEvent` on a later turn, to each channel in the order the channels were made. A channel never gets its own messages.
- `close()`, `ref()`/`unref()`, `onmessage`, and Node's errors are as in Node. An open channel keeps the program alive.
- Separate programs never hear each other, as separate Node processes don't.
- It never touches the platform's `BroadcastChannel`, which the kernel withholds on purpose because it would reach other contexts of the origin.
- It is the global: the lockdown leaves the slot writable.
