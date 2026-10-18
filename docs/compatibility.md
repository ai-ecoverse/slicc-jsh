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

- `node script.js`, `node -e`, `node -p`, `node -` (the program from stdin, even a terminal), and `node` with no script (the [REPL](#readline-and-the-repl) on a terminal, else the piped text as a script). `-i` forces the REPL.
- `-r X` / `--require X` loads `X` first, from the working directory. Its require stack is `internal/preload`.
- `--import X` loads the ES module `X` after the `-r` modules and before the entry, top-level `await` included.
- `--input-type=module|commonjs` for `-e` and piped input. `--input-type=module-typescript` and `commonjs-typescript` fail: there's no TypeScript.
- `--stack-trace-limit=N` sets `Error.stackTraceLimit`.
- `--max-old-space-size=N`, `--trace-uncaught` and `--trace-sigint` are accepted. The kernel sets a program's memory, the uncaught report is the usual one, and no stack is printed on SIGINT.
- A bad value for a V8 flag gets V8's report, followed by Node's `bad option` lines.
- Options after `-e`/`-p` are still node's, up to the first argument.
- `NODE_OPTIONS` is read as Node 22 reads it: words with spaces, quotes and escapes; only the options Node allows there; its options before the command line's and out of `execArgv`; Node's errors.
- Boolean options take `--x` and `--no-x`, and the last form wins. A value that looks like an option counts as missing (`--require --no-warnings`).
- Also: the [warning flags](#warnings), `--enable-source-maps`, `--preserve-symlinks`, `--preserve-symlinks-main`, `--expose-internals`, `--title`, `--pending-deprecation` and the `--report-*` options (they set `process.report`).
- `-c`/`--check` checks the script's syntax and runs nothing, as Node's `check_syntax` does. A file is checked as the module it is: ES module by extension, `"type"`, or detection. Piped input is checked as CommonJS unless `--input-type=module`. A SyntaxError gets the usual report under the script's real path, with exit status 1. Combined with `-e`/`-p`, it's an error (status 9).
- Any other option, such as `--inspect`, `--watch` or `--experimental-strip-types`, is `bad option` (status 9).

## Modules and ESM

**CommonJS.** `require` resolves as Node does: `node_modules`, `package.json` `"exports"` and `"imports"`, `node:` builtins, JSON. `require('.')` and `require('..')` are paths, and a request that ends in `/`, `/.` or `/..` names a directory, never the file beside it (golden `require-dot`). The module wrapper is Node's five-argument form. `process`, `Buffer` and the timers are real globals. Modules resolve through symlinks to their real path, unless `--preserve-symlinks` (or `--preserve-symlinks-main`). `module.createRequire`, `Module._extensions`, `Module.builtinModules` and `isBuiltin` are there.

**ESM.** `.mjs`, `"type": "module"`, static `import`/`export`, dynamic `import()`, `import.meta.url`, `import.meta.resolve`, `import.meta.dirname` and `import.meta.filename`, and JSON with `with { type: 'json' }`. The resolver, its errors and its stack frames are Node 22's. The transform uses acorn, so multi-line imports and exports, strings, comments and `$` identifiers parse correctly. Imports are hoisted, and export getters are registered before evaluation, so cycles work. `-e` and ambiguous `.js` files are detected as Node does; a dynamic `import()` alone stays CommonJS.

**Interop.**
- `import` of CommonJS: the named exports are what Node's cjs-module-lexer finds in the source, re-exports included. The default export is `module.exports` itself, never its `.default`.
- `require()` of an ES module with a default export returns Node's facade with `__esModule: true` and live bindings, or its `'module.exports'` export.
- `package.json` `"exports"` with `import`/`require` conditions.
- `import()` inside `new Function` and `AsyncFunction` bodies loads through the runtime, resolved against the calling script.

**ES module input.** With `--input-type=module`, the program is `<cwd>/[eval1]`, as in Node (`import.meta.url`, `filename`, `dirname`). Its `import.meta.resolve` gives a missing file's URL rather than throwing.

**Export conditions.** In the kernel, `require` resolves with `['slicc', 'require', 'node', 'default']` and `import` with `['slicc', 'import', 'node', 'default']`. Host Node never sets `slicc`, so a package can ship separate code for slicc-kernel.

**Source maps**, as Node 22's own `lib/internal/source_map`: `--enable-source-maps`, `process.setSourceMapsEnabled`, `module.findSourceMap`, `SourceMap`, `getSourceMapsSupport` and `setSourceMapsSupport`. Stacks and uncaught reports go through them.

**Stacks.** Frames name a module by its URL (query and fragment included) and count a CommonJS file's hashbang line, as Node's do. Timer callbacks' stacks keep the script's URL.

**`--expose-internals`** makes the internal modules carried in `src/node-lib` requirable (for Node's own tests).

**Not available:** `module.register`, `module.registerHooks`, `syncBuiltinESMExports`, `findPackageJSON`, `enableCompileCache`, `stripTypeScriptTypes`, native addons (`.node`), and TypeScript.

## `process` and the end of a program

**Exit.**
- `process.exit()` ends the program at once. That includes `cli.die`, `cli.help` and a fatal `kill(self)`. On slicc-kernel 1.65 and later it goes through `ctx.sync.exit`, so no `catch`, `finally`, microtask or timer of the program runs after it, as in Node. On older kernels the code it unwinds through still runs, silenced: no output, no further status change.
- `'exit'` listeners run first on every way out: the end of the loop, `process.exit()`, an uncaught error and an unhandled rejection. The `process.exitCode` they leave is the status. On an uncaught error they run before its report, and a `process.exit()` in one ends the program without the report.
- An unhandled rejection is raised as an uncaught exception first, as with Node's default `--unhandled-rejections=throw`. An `'uncaughtException'` listener (origin `'unhandledRejection'`) or the capture callback can take it. A reason that isn't error-like comes wrapped in an `UnhandledPromiseRejection`.
- Ticks queued by a timer, an immediate or the main script run before that callback's promise jobs. After a tick's uncaught exception is handled, the rest of the queue runs first too.
- Platform work in flight keeps the program alive until it settles, as Node's pending I/O does: WebCrypto (`crypto.subtle`), WebAssembly compilation, and, where the browser has WebGPU, `requestAdapter`, `requestDevice`, `mapAsync`, `onSubmittedWorkDone`, `createComputePipelineAsync`, `createRenderPipelineAsync`, `popErrorScope` and `getCompilationInfo`. `GPUDevice.lost` doesn't: it stays pending for the device's whole life.

**Signals and `kill`.**
- `process.kill(process.pid, sig)` delivers to `process.on(sig)` listeners on a later turn. Like Node's signal handles, they don't keep the program alive. With no listener, the program dies of the signal at once: status 128 + n, no `'exit'`. Its argument errors (`ESRCH`, `EINVAL`, `ERR_UNKNOWN_SIGNAL`) are Node's.
- On slicc-kernel 1.72.0 and later, `process.kill(process.pid | 0 | -pgid, sig)` and `process.abort()` end the program inside the call, through `ctx.sync.kill`, and `kill` reaches other processes. On older kernels the program unwinds, silenced, and another pid gives `ESRCH`.
- SIGPIPE is ignored from the start, as in Node, so a write to a pipe whose reader is gone fails with `EPIPE`. stdout and stderr are never really destroyed (Node's `dummyDestroy`): every failed write emits `'error'` again. `console` swallows only the first one, so a program that keeps logging to a dead pipe ends with status 1, as Node's does. Removing the last `'SIGPIPE'` listener brings back the default action (death by the signal, 141).

**Other members.**
- `process.chdir` throws Node's `ENOENT`/`ENOTDIR` errors. `process.ppid` comes from the kernel: on each read from `/proc` on slicc-kernel 1.89.0 and later (1 once the parent has ended), else the value at start. As in Node, an assignment to it changes nothing. It is an accessor property: Node's is a V8 native data property, which reports a writable `value` yet ignores writes, and plain JavaScript can't make one; a data property would let an assignment stick.
- `process.env` stores strings, as Node's does.
- `process.umask()` and `process.umask(mask)` work on the kernel's umask on slicc-kernel 1.92.0 and later (`ctx.sync.umask`). A child inherits it, and the kernel applies it to what the program creates. Arguments are parsed as Node's are. As in Node 22, calling it with no argument prints no warning (DEP0139 is documentation-only there).
- Older kernels:
  - `process.umask()` starts as the kernel's umask. jsh reads it once, from `/proc/self/status` on 1.89.0 and later, or before that from the mode the kernel gives a directory jsh makes in `/tmp`.
  - `process.umask(mask)` changes only the umask jsh applies to the files it creates; children keep the kernel's.
- `process.getuid`, `getgid` and the like read the kernel's credentials. `process.setuid`, `setgid`, `seteuid`, `setegid`, `setgroups` and `initgroups` follow Node on Linux; they're defined only on slicc-kernel 1.81.0 and later.
- `process.versions` lists what the runtime has or mirrors: no openssl, brotli, ….
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

**Paths.** Every path argument may be a `file:` URL (`fs.writeFileSync(new URL('./x', import.meta.url))`): sync, callback, promise and stream forms. A URL with another scheme, a host, or an encoded `/` gets Node's errors.

**Constants.** `fs.constants` is Node 22's set for Linux x86_64, in Node's order, and numeric `open` flags are read by those bits. `require('constants')` (deprecated in Node) is `os`'s dlopen, errno, priority and signals constants plus `fs`'s and `crypto`'s, frozen.

**Symlinks and `cp`.** `cp`, `cpSync` and `promises.cp` follow Node 22.22's own code, quirks included (goldens `fs-cp-sync`, `fs-cp-async`, `fs-readdir-links`):
- A symlink in a copied tree stays a symlink, with its target made absolute unless `verbatimSymlinks`. A linked directory is never descended into.
- `cpSync(src, dest, { recursive: true, dereference: true })` still copies a tree's symlinks as symlinks. That is Node 22.22's native `CpSyncCopyDir`. Only `fs.cp`/`promises.cp` (Node's `cp.js`) really dereference.
- `readdirSync({ recursive })` and `promises.readdir({ recursive })` with names descend into linked directories. `promises.readdir` with `withFileTypes` and `opendir({ recursive })` don't.
- `realpathSync` resolves every link.
- `linkSync` is the kernel's: it works on `tmpfs`, and fails with `EPERM` on the root file system and `fsa`, and with `EXDEV` across mounts.

**`statfs`.** `statfs`, `statfsSync` and `promises.statfs` return a `StatFs`. It is the kernel's storage estimate in 4 KiB blocks, reported as tmpfs: quota and usage on slicc-kernel 1.72 and later, else 1 GiB. The browser's storage has no inodes, so `files`/`ffree` follow the blocks.

**`/dev`.** On slicc-kernel 1.69 and later, devices (`/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/stdout`, `/dev/fd/N`, …) open as kernel descriptors and are read and written as streams, never whole. A link to a device is followed first. `/dev/stdin` and `/dev/fd/0` are `process.stdin`.

**Modes.** On slicc-kernel 1.86.0 and later, `chmod`, `fchmod` (and `FileHandle.chmod`, both by the descriptor's path) change the mode in the kernel:
- They follow a symlink, and only the permission bits count (`mode & 0o7777`, as Linux masks the rest).
- Only the file's owner or root may change a mode: anyone else gets `EPERM`, with Node's error (`code`, `syscall` `chmod`, `path`).
- Arguments are parsed as Node 22 parses them: octal strings such as `'755'`, `ERR_INVALID_ARG_VALUE`/`TYPE`, `ERR_OUT_OF_RANGE`.
- A script a program writes and `chmod`s `0o755` runs by path: spawn, `#!`, binfmt, the shell.

On older kernels `chmod` and `fchmod` check their arguments and that the path exists, change nothing, and say so once, with a warning (`JSH_NO_CHMOD`).

**Owners and times.** `chown`, `lchown`, `fchown`, `utimes`, `lutimes` and `futimes` check their arguments and that the path (or fd) exists, as Node's do, and change nothing, on every kernel: the kernel's JS file system has no call for them. There is no `fs.lchmod` or `lchmodSync`, as in Node on Linux, and `promises.lchmod` rejects with `ERR_METHOD_NOT_IMPLEMENTED`.

**Arguments first.** As in Node, fs checks its arguments before it touches the file system: open's flags, the data of `writeFile`/`appendFile`, and every `mode`. A path with a NUL byte is `ERR_INVALID_ARG_VALUE` (`existsSync` says `false`).

**New files' modes.** On slicc-kernel 1.86.0 and later, a file or directory fs creates gets the mode it asked for, less `process.umask()`, as in Node. On 1.92.0 and later the kernel creates it with that mode, so there's never a moment with another; on 1.86.0 to 1.91.x jsh `chmod`s it right after:
- `writeFile`, `appendFile`, `open`, `FileHandle`s and `createWriteStream`: `mode`, default `0o666`;
- `mkdir`, recursive included: `mode`, default `0o777`;
- `mkdtemp`: `0o700`.

An existing file keeps its mode. `copyFile` gives the copy the source's mode, whether the copy is new or replaces a file, as libuv does. `cp` copies files the same way; the directories it makes get the default mode. On older kernels new files are `0666` and directories `0777`, less the kernel's umask.

**`mkdir`** without `recursive` is the kernel's exclusive mkdir on slicc-kernel 1.86.0 and later. It gives `EEXIST` for an existing name and `ENOENT` for a missing parent (`ENOTDIR` under a file), and of two processes making one name, exactly one succeeds, so a directory works as a lock. That holds among the processes of one kernel, not between two kernels on one origin, such as two tabs ([slicc-kernel#519](https://github.com/ai-ecoverse/slicc-kernel/issues/519)). On older kernels it checks that the path doesn't exist and then creates it. Those are two steps, so two programs racing for the same name can both succeed, and a missing parent is created rather than giving `ENOENT`. `recursive: true` works as in Node, returning the first directory it made.

**`rm` with `recursive`.** `rm`, `rmSync`, `promises.rm` and recursive `rmdir` validate their options as Node does, and `force` forgives a missing path only. They run Node 22's rimraf step for step on the kernel's calls, so what is removed, what is left and the error are Node's:
- `rmSync` `rmdir`s a directory first, and empties it only when that says `ENOTEMPTY`, `EEXIST` or `EPERM`. Any other error stops it where it is. A tree with a `0555` subdirectory fails on that subdirectory's own `rmdir` (`EACCES: permission denied, rmdir 't6/a/b/c'`) and keeps everything, and `rmSync('/dev', { recursive: true })` as a user fails on `rmdir '/dev'`.
- `rm` and `promises.rm` work through a directory's entries side by side, so the entries beside the one refused still go. Node's thread pool may report either of two refusals that come back together. jsh's steps run in the order they're issued, so the one it reports is fixed.
- `rmdir(2)` of a directory with entries checks the parent's permission first, as Linux does.

On slicc-kernel 1.72.0 to 1.85.x, `chmod` changes nothing (see Modes), so a `0555` directory can't be made there in the first place. The modes those kernels report aren't enforced, so jsh doesn't check them either: there, `rmdir` of a directory with entries is `ENOTEMPTY`, and `rmSync('/dev', { recursive: true })` fails on its first entry's `unlink`.

`/dev` entries can't be removed: `unlink`, `rm` and `rmSync` of them give `EACCES` for a user and `EPERM` for root, from the kernel on 1.93.0 and later, and from jsh before that, where the kernel says `ENOENT` or reports a success that removed nothing.

**Not available:** `watch`, `watchFile`, `unwatchFile`, `glob`, `globSync`, `promises.glob`, `promises.watch`, `openAsBlob`, `readv`, `writev`, `fs.Dir` as an export (`opendir` works), and `promises.constants`.

## `child_process`

**Async.** `spawn`, `execFile` and `exec` (through `sh -c`) run on the kernel's `ctx.spawn`:
- argv, env and cwd; Node's errors for a bad `cwd`, a missing command (`ENOENT`) and a file without `x` (`EACCES`), as `'error'` and then `'close'` with the negative errno, never thrown;
- stdio `inherit`, `pipe` and `ignore`, with streams on `.stdin`, `.stdout` and `.stderr`;
- the events `spawn`, `exit`, `close` and `error`; `.kill(signal)`; `.pid`.
- On slicc-kernel 1.87.0 and later (`ctx.sync.spawn`), the child starts inside `spawn()`, so `.pid` is set when it returns and a `kill()` or `process.kill(child.pid)` right after reaches it, as in Node. On older kernels it starts a tick later, and `.pid` is set by `'spawn'`.

**Finding the command.** A bare name is found on the child's `PATH` (`options.env`'s, else `/usr/bin:/bin`), as `execvp` does, for `spawn`, `execFile`, `spawnSync` and `execFileSync`:
- The first directory with an executable regular file wins. Directories and files without `x` are passed over, and an empty entry means the cwd.
- `EACCES` when only files without `x`, or directories, match. A directory run by path is `EACCES` too, as `execve` gives it. The kernel says so from 1.93.0; before that it says `ENOENT`, and jsh maps it.
- The kernel's commands are files in `/usr/bin` and `/bin`, so `PATH` order decides a clash, as it does for bash in the kernel. A name found nowhere on the child's `PATH` is `ENOENT`, as in Node, even when the kernel knows a command of that name (`env: { PATH: '/nonexistent' }` doesn't find `sh`).
- A name with a `/` is never searched.

**Sync.** `spawnSync`, `execSync` and `execFileSync` are Node 22's own option handling and result and throw shapes, on the kernel's `ctx.sync.run`. They need slicc-kernel 1.65.0; on an older kernel they throw `ERR_NOT_SUPPORTED`, naming the version needed. Supported:
- `encoding`, `input`, `cwd`, `env`;
- `stdio` `pipe`, `ignore` and `inherit` (the program's own fds and terminal included);
- `shell` (`/bin/sh`);
- `timeout` and `killSignal` (`ETIMEDOUT`), `maxBuffer` (`ENOBUFS`);
- `ENOENT` on `.error`;
- `execSync`/`execFileSync` throw with `status`, `signal`, `stdout`, `stderr`, `output` and `pid`.

**Other fds as stdio.** A stdio slot can be another fd.
- On slicc-kernel 1.70.0 and later, the program's own fds go straight to the child, and stdout and stderr sent to one fd keep the child's write order. An fd from `fs.openSync` (jsh's own) is written after the run.
- On older kernels every other fd is written after the run, stdout before stderr.
- stdio slots past fd 2 are not passed to the child.

**`argv0`.** On slicc-kernel 1.76.0 and later the child sees `options.argv0`, else the file as given, as its `argv[0]`. That holds for jsh's own `node` and `jsh` too, so a jsh child's `process.argv0` is the `argv0` it was given. A command whose manifest sets its own `argv0` keeps that. Older kernels only use `argv0` in error messages.

**`detached: true`** makes the child lead a new session and process group (`setsid`, as Node does on POSIX) on slicc-kernel 1.74.0 and later. Older kernels keep it in the program's group.

**pnpm.** `fs.realpathSync`, `process.getuid`/`getgid` and `process.kill(self)` are there for pnpm's global command shims, which resolve their target and re-raise signals. Piped stdio loads `readable-stream` from sources embedded in the bundle, so a package installed with `pnpm add -g` (under `$PNPM_HOME/global/v11/<hash>/`) works.

**Not available:** `fork` throws `ERR_NOT_SUPPORTED`.

## `net`, `http` and `https`

**Where they reach.** `net` and `http` are TCP on the kernel's sockets (`ctx.net`).
- Loopback (`127.0.0.0/8`, `localhost`, `*.localhost`, `0.0.0.0`) is always the kernel's own, IPv4 only. A server is reachable from other programs in the kernel and, as `<port>.kernel.localhost`, from the page.
- Another host is real TCP when the embedder gives the kernel an uplink that routes it (an exit node, or a route table). The name is resolved through the uplink, and the request goes out byte for byte.
- Without a route (no uplink, or an address outside its routes), the connect fails. `net` reports Node's error: `getaddrinfo ENOTFOUND <name>` for a name nothing resolves, else `connect <CODE> <host>:<port>`. `http.request` then sends the request through `fetch` instead (see the fetch fallback below).
- `https` goes through `fetch`, except a request with its own agent (or, on slicc-kernel 1.124.0 and later, a `ca`), which is `http` on a `tls.connect` socket (see the `https` client below).

**`net`.** Servers and sockets, `allowHalfOpen`, `end()` as a half-close. Unix domain sockets (`path`) and `new net.Socket({ fd })` throw `ERR_NOT_SUPPORTED`.

**`http` server.**
- Request bodies are read whole before the `'request'` handler runs. A body over 64 MiB gets `413 Payload Too Large`.
- Responses stream, as Node's: a `write()` before `end()` (or `flushHeaders()`) sends the head and each chunk as it comes, chunked unless a `Content-Length` is set. SSE and long-poll servers work. `end()` alone sends one framed response.
- Headers can't change once the head is sent (`ERR_HTTP_HEADERS_SENT`).
- `http.STATUS_CODES` is Node 22's whole table. A status not in it gets the reason phrase `unknown`, as in Node.
- Keep-alive works as in Node 22:
  - A connection stays open after a response that may leave it so: an HTTP/1.1 request without `Connection: close` and a framed body. Such a response says `Connection: keep-alive` and `Keep-Alive: timeout=N`; any other response says `Connection: close`.
  - Requests on a connection are served one after another, pipelined ones in order.
  - An idle connection closes after `server.keepAliveTimeout` (5 s) plus `server.keepAliveTimeoutBuffer` (1 s), as in Node 22. `closeIdleConnections()` and `closeAllConnections()` end connections as Node's do.
  - `close()` closes the connections that are idle at that moment. One that is busy keeps serving after its response, as in Node 22: it still says `Keep-Alive`, takes further requests, and closes when it goes idle for that long or the client ends it. The callback waits until every connection has closed.
  - `maxRequestsPerSocket` is honoured. Headers that don't arrive within `headersTimeout` get `408`.
- An `Upgrade` request goes to `'upgrade'` listeners, with the socket and what followed the head. Without a listener, it is an ordinary request.
- Header names are written as they were set.

**`http` client.**
- With a `Content-Length`, request body bytes stream as written. Without one, the body is buffered until `end()` and sent with a computed length. Request bodies aren't sent chunked.
- `'response'` comes at the head, and the body streams as it arrives: by `Content-Length`, chunked, or until the peer's FIN. `socket.end` half-closes. A chunked body's trailers are `res.rawTrailers` and `res.trailers` by its `'end'`.
- `http.validateHeaderName`, `http.validateHeaderValue` and `http.setMaxIdleHTTPParsers` are Node's (golden `http-validate-headers-node22`).
- A `ClientRequest` has its `Host` header from the start, set after the given headers and before the agent's `addRequest` sees the request. It's absent with `setHost: false`. The request line is the request's `method` and `path` as they are when it's sent. `_header` and `_implicitHeader()` are Node's. That lets **http-proxy-agent** rewrite the path to the absolute URL and send through a plain `http://` proxy.
- `http.Agent` follows Node's `_http_agent.js` request path (`addRequest` → `createSocket` → `createConnection`), so **agent-base** subclasses work for plain `http`. `getName`, `destroy`, `keepSocketAlive`, `reuseSocket`, `removeSocket`, and `sockets`/`freeSockets`/`requests` are present.
- `http.globalAgent` keeps sockets alive, as in Node 22 (`keepAlive: true`, `scheduling: 'lifo'`, `timeout: 5000`). An agent with `keepAlive` reuses a socket once its response is done (`'free'`, then `req.reusedSocket`), queued requests first. As in Node 22, a server's `Keep-Alive: timeout=N`, less `agentKeepAliveTimeoutBuffer` (1 s), caps a free socket's timeout, and a hint that leaves nothing (`timeout=1`) means the socket isn't reused. Free sockets don't keep the program alive, and one the server closes leaves the pool. `agent: false`, or an agent without `keepAlive`, sends `Connection: close`.
- A connection that closes before its response gives `socket hang up` (`ECONNRESET`). A `101` response is `'upgrade'` (response, socket, head), and without a listener the connection closes.

**The fetch fallback** (plain `http` without a route, and an `https` request without an agent). The request is sent once it has ended, through jsh's `fetch`: the embedder's transport, and `host.slicc.internal` through the kernel's proxy. What a fetch can't carry, it doesn't:
- **No raw socket.** `res.socket` and `req.socket` are `null`. There is no `'socket'` or `'connect'` event, no Agent pooling or keep-alive, no `upgrade` or `CONNECT`, no 1xx responses or `Expect: 100-continue`, and no trailers.
- **Normalized headers.** Response header names arrive lowercased in `rawHeaders`, and repeated headers other than `set-cookie` are joined. The headers fetch owns (`Host`, `Connection`, `Content-Length`, `Transfer-Encoding`, `Keep-Alive`, `Expect`, `Upgrade`, `TE`, `Trailer`) are fetch's to set, so a custom `Host` doesn't reach the server.
- **Buffered upload.** The request body is sent whole, after `end()`.
- **Streamed download.** The response body streams as it arrives. `set-cookie` is an array, and a missing reason phrase is Node's.
- **Redirects.** Requests use `redirect: 'manual'`, so a 3xx shows as `statusCode` and `Location`, as in Node. A browser transport can't do that (an opaque redirect), so there jsh follows redirects instead (see below).
- **Refused, not changed.** What fetch can't send fails with `ERR_NOT_SUPPORTED` before anything goes out: the methods it forbids (`CONNECT`, `TRACE`, `TRACK`), and a `GET` or `HEAD` with a body.
- **Agents.** A request with its own agent (a subclass of `http.Agent`, or one with its own `createConnection`, `addRequest` or `createSocket`, as a proxy's has), a `socketPath`, or a kernel without `ctx.fetch` gets the connect error instead. A plain `new http.Agent(…)` takes the fallback.
- If `fetch` has no network either, the error is the connect's (`getaddrinfo ENOTFOUND`, `connect ENETUNREACH`). A name the transport can't resolve is `getaddrinfo ENOTFOUND <name>` (or `EAI_AGAIN`) on slicc-kernel 1.93.0 and later, which passes the resolver's errno. Older kernels say `ECONNREFUSED`.
- `https` to the kernel's own loopback (`127.0.0.1`, `localhost`) connects first, so a port nothing listens on is `connect ECONNREFUSED 127.0.0.1:<port>`; the loopback has no TLS, so a listening port is `ERR_NOT_SUPPORTED`.
- Errors name a loopback name by its address, `127.0.0.1`, as Node's resolver gives it. `res.req` has the request's `method`, `path`, `host` and `protocol`.

**`https` client.** `https.request` and `https.get` take the fetch fallback above, except on slicc-kernel 1.116.0 and later for a request with its own agent (an `https.Agent`, a proxy agent's) or its own `createConnection` (ws's `wss://`), and on 1.124.0 and later for a request with a `ca` (with `https.globalAgent`, or a fresh agent for `agent: false`, as in Node). Such a request is `http`'s socket client on a `tls.connect` socket (see `tls`), with keep-alive, `rawHeaders` as sent, trailers (`rawTrailers`, `trailers`) and `'upgrade'`. It never falls back to `fetch`.
- The request's own options reach the agent, as in Node (`addRequest` → `createSocket` → `createConnection`), so `ca`, `servername` and `rejectUnauthorized` reach `tls.connect`. The SNI is Node's `calculateServerName`: the `Host` header's name, else `host`, never an IP address.
- `https.Agent` is Node's: `http.Agent` with TLS sockets, `defaultPort` 443, and the TLS options in its socket names.
- The fetch fallback's `ClientRequest` is an `EventEmitter`, not a stream.
- `cert`, `key` and `pfx` throw `ERR_NOT_SUPPORTED`: no client certificates. Before slicc-kernel 1.124.0 so does `ca`.
- Without an agent, `rejectUnauthorized: false` is accepted but ignored: fetch verifies. Over a socket, it's `tls.connect`'s (see `tls`).
- Why a request without an agent stays on `fetch` on 1.124.0: to a host the uplink doesn't route, the socket would be the transport's TLS (A1) as well, with the same headers and no trailers, and a name that doesn't resolve would come back as a `502` response instead of Node's `getaddrinfo ENOTFOUND` error, which `fetch` gives.
- Redirects: requests use `redirect: 'manual'`, so a redirect shows as `statusCode` and `Location`, as in Node. On the browser entry the transport may refuse that with `ENOTSUP`; jsh then falls back to `'follow'`, so plain requests work but a redirect is followed instead of surfaced. The Node entry's transport supports manual redirects. Embedders with `traits.redirectHops` ([slicc-kernel#315](https://github.com/ai-ecoverse/slicc-kernel/issues/315)) can surface redirects in the browser.

**Not available:** `https.createServer` throws `ERR_NOT_SUPPORTED`, as does anything in `tls` that needs a handshake (below).

## `tls`

`require('tls')` and `import … from 'node:tls'` load with Node 22.22.0's exports. **ws** runs: its `ws://` server over an `http` server's `'upgrade'`, its client, and (see below) its `wss://` client. **agent-base**, **http-proxy-agent** and **https-proxy-agent** load too. http-proxy-agent sends plain `http` requests through an `http://` proxy (see `http`). https-proxy-agent's tunnel needs TLS over an open socket, which works on slicc-kernel 1.124.0 and later (below).

The kernel does the TLS, by one of two paths ([slicc-kernel#914](https://github.com/ai-ecoverse/slicc-kernel/issues/914)). jsh has no TLS of its own.

**A2: the kernel's own handshake, on slicc-kernel 1.124.0 and later** ([slicc-kernel#922](https://github.com/ai-ecoverse/slicc-kernel/issues/922)), for a host the kernel's uplink routes as raw TCP. The embedder installs `@ai-ecoverse/wasm-tls-engine` (4.2.0-2 or later). What works, as in Node:
- **Any port and protocol.** `tls.connect({ host, port })` with any ALPN list: pg, SMTPS, IMAPS, MQTT over TLS, Redis over TLS, HTTP/2's ALPN. jsh asks for the kernel's handshake on any port but 443. On 443 the kernel keeps the transport's path (A1, below) unless the call needs a real handshake: a `ca`, ALPN without `http/1.1`, `rejectUnauthorized: false` or a `checkServerIdentity` of its own. To a host the uplink doesn't route, the call falls back to A1.
- **STARTTLS and TLS over an open socket.** `tls.connect({ socket })` and `new tls.TLSSocket(socket, { isServer: false })` over a `net.Socket` upgrade its connection in place (`ctx.net.connect({ socket, host, tls })`). pg's `SSLRequest`, nodemailer's `STARTTLS` and https-proxy-agent's `CONNECT` tunnel work. What was written in plain text goes out before the handshake, and the plain socket emits nothing more, then `'close'` just before the TLS socket's, as in Node. A socket that is still connecting is upgraded once it has connected. A bare `TLSSocket` starts its handshake at its first write and emits `'secure'`, not `'secureConnect'`, and doesn't verify (`authorized` stays `false`), as in Node.
- **A custom `ca`**, in `tls.connect`, `createSecureContext({ ca })` (and `secureContext`), and `https.request`. It replaces the kernel's trust store (Mozilla's roots, which the engine package ships), as in Node.
- **Verification is Node's.** The kernel verifies the chain and reports what it found; jsh then applies Node's `onConnectSecure` before any application byte is sent or delivered:
  - the chain's error has Node's code and OpenSSL's message: `SELF_SIGNED_CERT_IN_CHAIN`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `CERT_HAS_EXPIRED`, `CERT_NOT_YET_VALID`, `INVALID_PURPOSE`;
  - then `checkServerIdentity(servername || host, cert)`, Node's or the caller's, so `ERR_TLS_CERT_ALTNAME_INVALID` has Node's `reason`, `host` and `cert`;
  - `rejectUnauthorized: false` connects and sets `authorized: false` and `authorizationError` (the code). Otherwise the socket is destroyed with the error, after `'secure'`.
- **The session.** `getPeerCertificate()` is Node's object, read from the DER chain the kernel hands over (`subject`, `issuer` and `infoAccess` with null prototypes, `subjectaltname`, `ca`, `bits`, `pubkey`, `modulus`/`exponent` or `asn1Curve`/`nistCurve`, `valid_from`, `valid_to`, the three fingerprints, `ext_key_usage`, `serialNumber`, `raw`). `getPeerCertificate(true)` links `issuerCertificate` through the chain the server sent, then the `ca` given, and a self-signed root points to itself. `getProtocol()` is `'TLSv1.3'` or `'TLSv1.2'`, `alpnProtocol` is the agreed protocol or `false`, `servername` is the SNI given (or `false`), and `isSessionReused()` is `false`.
- **Still different:** `getCipher()`, `getEphemeralKeyInfo()`, `getFinished()`, `getPeerFinished()`, `getSession()`, `getTLSTicket()` and `getSharedSigalgs()` are `null`, because the kernel doesn't report them. `getPeerX509Certificate()` is `undefined` (jsh has no `X509Certificate`). There's no session resumption, no revocation check, and no `minDHSize` check. Without a `servername`, the kernel still sends `host` as the SNI, where Node sends none. A handshake failure other than the certificate's is `ERR_SSL_HANDSHAKE_FAILURE` with the engine's reason, and a server that closes during the handshake is Node's `ECONNRESET` ("Client network socket disconnected before secure TLS connection was established"). Sealed placeholders written into an A2 connection reach the server unsubstituted (the kernel's `substitutes: false`).
- **Refused with `ERR_NOT_SUPPORTED`:** client certificates (`key`, `cert`, `pfx`), a server-side `TLSSocket` over a socket, TLS over a stream that isn't a `net.Socket`, TLS over a socket the uplink doesn't route (a loopback one), and a `ca` for a host the uplink doesn't route.

**A1: the transport's TLS, on slicc-kernel 1.116.0 and later** ([slicc-kernel#923](https://github.com/ai-ecoverse/slicc-kernel/issues/923)), for every other `tls.connect`. The kernel serves the plain HTTP/1.1, and WebSocket upgrades, through the embedder's transport, which does the real handshake and verifies the peer. Sealed placeholders are substituted, as for `fetch`.
- `'connect'`, `'secure'` and then `'secureConnect'` (the callback) come once the kernel has the session. `authorized` is the transport's (`true`), and so is `alpnProtocol` (`'http/1.1'`). `servername` is the SNI given, else `false`, as in Node. Before 1.124.0 it's the name the transport reached.
- `getPeerCertificate()` is `{}`, and `getProtocol()` is `null`: the transport keeps the certificates, so `checkServerIdentity` isn't called. `rejectUnauthorized: false` changes nothing, because the transport always verifies.
- What the transport won't carry fails with `ERR_NOT_SUPPORTED` on the socket's `'error'`: another protocol's well-known port (465, 993, 995, 636, 853, 8883, …), ALPN without `http/1.1`, and the kernel's own loopback, which the transport doesn't reach.
- So `https` with an agent and ws's `wss://` client work there.

**On older kernels** whatever needs a handshake throws `ERR_NOT_SUPPORTED` (`slicc-jsh: '<what>' is not supported yet (no TLS on ctx.net)`, as `https.createServer` does) when it's called, not when the module loads:
- `tls.connect` before 1.116.0, after Node's checks of `checkServerIdentity` and `minDHSize`. Before 1.124.0, `tls.connect` over an open `socket` also throws, and so do `new tls.TLSSocket(socket)` and `createSecureContext({ ca })`.

On any kernel these throw `ERR_NOT_SUPPORTED`:
- `listen()` on a `tls.Server`, and `connect()` on a `TLSSocket`.
- `createSecureContext` (and so `createServer`) with key material other than `ca`: `cert`, `key`, `pfx`, `crl`, `dhparam`, a private-key engine or a client-certificate engine. Each one's type is checked first, as Node checks it.
- `createSecurePair`, which is deprecated (DEP0064).

What doesn't need a handshake is Node's:
- `checkServerIdentity`: Node's matching (wildcards, the CN fallback, quoted altnames, IP addresses compared in canonical form), returning `ERR_TLS_CERT_ALTNAME_INVALID` with `reason`, `host` and `cert`, or throwing `ERR_TLS_CERT_ALTNAME_FORMAT`.
- `convertALPNProtocols`, `getCiphers()` (Node 22.22.0's list, from its OpenSSL), `DEFAULT_CIPHERS`, `DEFAULT_ECDH_CURVE`, `DEFAULT_MIN_VERSION`, `DEFAULT_MAX_VERSION` (both follow `--tls-min-v1.x`, `--tls-max-v1.x` and `--tls-cipher-list`), `CLIENT_RENEG_LIMIT` and `CLIENT_RENEG_WINDOW`.
- `createSecureContext` and `SecureContext`, with Node's option checks and errors (`ERR_TLS_INVALID_PROTOCOL_VERSION`, `ERR_TLS_PROTOCOL_VERSION_CONFLICT`, …).
- `TLSSocket` extends `net.Socket`, and `Server` extends `net.Server` (callable without `new`, as in Node), so `instanceof` checks and subclasses work. `new tls.TLSSocket()` without a socket has `encrypted: true` and `authorized: false`, and its session getters answer as Node's do before a handshake (`getPeerCertificate()` is `null`, `exportKeyingMaterial` is `ERR_TLS_INVALID_STATE`). A `tls.Server` keeps its options, contexts (`addContext`) and ticket keys.

**`rootCertificates` is an empty frozen array**, and so are `getCACertificates('bundled')`, `'system'` and `'extra'`. The trust store is the kernel's (or the transport's), not jsh's, so Node's 146 bundled certificates (about 220 KB) would be trust anchors nothing in jsh uses. `setDefaultCACertificates` checks its arguments as Node does and keeps the list as given, which `getCACertificates()` returns; it doesn't change what the kernel trusts.

The golden `tls-node22` checks the export list and these behaviours against Node 22.22.0. `test/integration/tls-kernel.test.mjs` runs the same programs on host Node 22.22.0 and in a kernel with a fake uplink to the same TLS servers (a raw echo, failed verifications, STARTTLS, pg, nodemailer, https-proxy-agent, `https` with an agent), and compares their output.

## `http2`

`require('http2')` and `import … from 'node:http2'` load with Node 22.22.0's exports. Packages that require `http2` at load but use it only behind an option load and run over HTTP/1.1. **axios** (unless `httpVersion: 2`), the AWS SDK v3's **@smithy/node-http-handler** (`NodeHttpHandler`), googleapis and superagent are examples. got and fastify also need `dns` at load.

There are no HTTP/2 sessions: h2 needs TLS on `ctx.net`, and h2c needs a frame layer jsh doesn't have. These calls throw `ERR_NOT_SUPPORTED` (`slicc-jsh: '<what>' is not supported yet (…)`) when they're made:
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

`require('dns')`, `require('dns/promises')` and their ESM forms load with Node 22.22.0's exports, argument checks and errors. So do the packages that require `dns` at load: **pg**, **mongodb**, **ioredis**, **redis**, **undici**, **nodemailer**, **fastify**, and **got** (which also needs `http2`).

**`lookup`** (callback and promise forms, `all`, `family`, `order`/`verbatim`, `hints`) is getaddrinfo. An IP literal answers at once.
- **On slicc-kernel 1.113.0 and later**, jsh asks the kernel's resolver (`ctx.net.resolve`). It answers from `/etc/hosts`, then the kernel's own names, then the uplink, the same answers WASI programs get. A name it doesn't know is `getaddrinfo ENOTFOUND <name>`, and one it can't answer for now is `getaddrinfo EAI_AGAIN`.
- **On older kernels**, jsh answers the kernel's names as its hosts file has them:
  - `localhost`, `localhost.localdomain`, `ip6-localhost` and `*.localhost` are `127.0.0.1` and `::1`, IPv4 first (`order: 'ipv6first'` swaps them);
  - the kernel's own hostname (`slicc`) is `127.0.1.1` and `::1`;
  - `host.slicc.internal` is `10.0.2.2`.

  Any other name is `getaddrinfo ENOTFOUND <name>` (`code` `ENOTFOUND`, `errno` -3008, `syscall` `getaddrinfo`, `hostname`), as in a Node with no resolver.
- `net.connect`, `http.request` and `fetch` don't go through `dns.lookup`: a name passed to them is resolved by the kernel, as before.

**`lookupService`** names the kernel's own addresses (`127.0.0.1` and `::1` are `localhost`) and the common TCP services from `/etc/services` (`ssh`, `http`, `https`, …). It gives any other address and port back as numbers.

**Queries** (`resolve*`, `Resolver`): on slicc-kernel 1.113.0 and later, `resolve4` and `resolve6` ask the kernel's resolver (`ttl: true` gives a TTL of 0), and a name it doesn't know is `queryA ENOTFOUND <name>`. There's no DNS transport for the other record types, so such a query finds no nameserver and fails as c-ares does then, with `query<Type> ECONNREFUSED <name>` (for example `queryMx` or `querySrv`; `mongodb+srv://` needs SRV records). So does `resolve4`/`resolve6` on older kernels. `reverse` names the kernel's own addresses. `getServers()` is empty until `setServers` (checked as Node does) sets a list. `cancel()` ends the pending queries with `ECANCELLED`.

`ADDRCONFIG`, `ALL` and `V4MAPPED` have Linux's values. `getDefaultResultOrder` follows `--dns-result-order`. `util.promisify(dns.lookup)` and `promisify(dns.lookupService)` resolve to Node's `{ address, family }` and `{ hostname, service }`.

The golden `dns-node22` checks the surface against Node 22.22.0, and `test/integration/dns.test.mjs` checks the kernel's answers.

## `fetch` and `WebSocket`

`globalThis.fetch` and `globalThis.WebSocket` run on the kernel's `ctx.fetch` and `ctx.websocket`. A request in flight keeps the program alive, and so does reading its body. `new WebSocket` checks its URL and protocols as Node 22's does: `http:` and `https:` become `ws:` and `wss:`, another scheme, a fragment, a duplicate or a non-token protocol is a `SyntaxError` `DOMException`, and `.url` is the parsed URL.

**Loopback.** As with Node on a machine, a loopback URL reaches a server of *this* kernel. The loopback names are `127.0.0.0/8`, `::1`, `0.0.0.0`, `localhost`, `*.localhost` and `<port>.kernel.localhost`. jsh does the HTTP over the kernel's sockets on every kernel. A `ws:` URL goes to the kernel's own loopback `ctx.websocket` on slicc-kernel 1.106.3 and later, which answers as undici does ([slicc-kernel#822](https://github.com/ai-ecoverse/slicc-kernel/issues/822)). On older kernels jsh does the WebSocket handshake and framing over the kernel's sockets itself. Either way, `new WebSocket(process.env.SLICC_CDP_URL)` reaches the kernel's CDP facade on 127.0.0.1:9222, and the loopback WebSocket holds the server to RFC 6455 as undici does. The one difference between the two is the message of a refused upgrade's `event.error.cause` (`… with 503 Service Unavailable` from the kernel, `… with 503` from jsh).
- A loopback redirect to another origin drops `authorization`, `proxy-authorization`, `cookie` and `host`.
- A body is decoded as undici decodes it: `gzip`, `x-gzip`, `deflate` and `br` (`br` through zlib, so one cut short ends without an error and a corrupt one fails the read with `TypeError: terminated`), a list of them last first, none if one is unknown, and more than five is `fetch failed`. The request asks for `gzip, deflate`, as undici does for `http:`.
- `host.slicc.internal` (and `10.0.2.2`) reach the real machine's loopback, through the kernel's proxy.

**Why not the kernel's loopback `fetch`.** The kernel's own loopback `ctx.fetch` (added in [slicc-kernel#510](https://github.com/ai-ecoverse/slicc-kernel/issues/510)) still differs from Node's undici in two ways, so jsh keeps its own:
- the request on the wire has none of undici's default headers (`accept`, `accept-language`, `sec-fetch-mode`, `user-agent`, `accept-encoding`); the kernel declined adding them ([slicc-kernel#599](https://github.com/ai-ecoverse/slicc-kernel/issues/599));
- it is sent with `connection: close`, where undici keeps the connection alive.

A third difference is fixed from slicc-kernel 1.110.5: before that, an abort no longer reached a body being read once a garbage collection had taken the request ([slicc-kernel#888](https://github.com/ai-ecoverse/slicc-kernel/issues/888)).

**A refused `WebSocket` connect** (slicc-kernel 1.59.1 and later on the Node entry): jsh emits an `error` event and no `close`, and `readyState` stays `CONNECTING`, as Node 22's undici does. The kernel's `cause.code` is passed through on `event.error.cause` (`ECONNREFUSED`, `EAI_NONAME`, `EHOSTUNREACH`/`ENETUNREACH`, `ETIMEDOUT`, `EPROTO`). Node's own `ErrorEvent.error` has no `.code` or `.cause`, so jsh doesn't add one to the event.

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

**Not available:** Brotli compression (`brotliCompress`, `createBrotliCompress`, …) and Zstd throw `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. Their callback forms (`brotliCompress(buf, cb)`, …) pass it to the callback.

## Streams and `Buffer`

**Streams.** `stream` and `stream/promises` are readable-stream 4, loaded on first use. `Readable`/`Writable`/`Duplex` `fromWeb`/`toWeb` are Node's adapters. `stream/web` is the platform's WHATWG streams. `stream/consumers` is Node's own. `string_decoder` is the npm `string_decoder`, Node's own code; it accepts any TypedArray. Every stream and `string_decoder` share jsh's `Buffer` class.

**`Buffer`.**
- Buffer views share memory with their source, as in Node.
- `Buffer.allocUnsafe` and `allocUnsafeSlow` zero-fill, and `Buffer.poolSize` is `0` (no pool).
- Encodings are as in Node 22's `lib/buffer.js`. `from`, `toString`, `write`, `fill` and `indexOf`/`lastIndexOf`/`includes` throw `ERR_UNKNOWN_ENCODING` for an encoding Node doesn't know; `byteLength` counts it as UTF-8, as Node does. base64 decoding is forgiving, `ascii` drops the high bit, and `write` never writes part of a character. A string that is too long is `ERR_STRING_TOO_LONG`.
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
- `util.inspect` is node-inspect-extracted, with Node 22's symbol-key and `byteLength` output.
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

- `runInThisContext` keeps a script's top-level declarations for the next script, as V8 does. To do that, top-level `let`/`const`/`class` become `var`, so a `const` isn't read-only and a name can be declared twice.
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
- `AsyncResource`: `runInAsyncScope`, `bind`, `AsyncLocalStorage.bind` and `snapshot`.

EventEmitter listeners run in the context of the code that emits, as in Node. The golden `async-local-storage-node22` checks these against Node 22.22.0.

**The gap: a native `await` continuation loses the store.** The engine resumes it, and jsh can't attach a context to that. The code after an `await` inside `run()` sees the store that's current outside every run, usually `undefined`. It **never sees another run's store**, so request-scoped code fails visibly (a missing store), never with the wrong identity. Callbacks the runtime's own I/O fires (a socket's `'data'`, an `http` server's `'request'`) behave the same way.
- Register a `.then()` inside the run, or wrap the callback with `AsyncLocalStorage.bind()`/`snapshot()`, to keep the store.
- `enterWith` where jsh can't bound it (after a native `await`, or in such an I/O callback) throws `ERR_NOT_SUPPORTED`. Otherwise its store would reach unrelated code; use `run()` there. In the main module, `-e` and the callbacks jsh schedules, `enterWith` works as in Node, and its store reaches what that code schedules.
- No warning is printed, so output stays Node's.
- `test/integration/async-local-storage.test.mjs` checks the gap. That includes two runs interleaving across `await`s, where neither ever sees the other's store.

**`domain`** is Node's own `lib/domain.js`. It follows a domain into the ticks, timers and immediates queued inside it, which is where Node's async hooks take it. A throw there is the domain's `'error'`, and so is an emitter's `'error'`. Promise jobs are the gap: the runtime can't see them, so a rejection isn't routed to a domain.

**`diagnostics_channel`** is Node's own, `tracingChannel` included.

**`perf_hooks`:**
- `performance` and the `Performance*` classes are the program's own, and `constants` are Node's.
- `createHistogram` and `monitorEventLoopDelay` are Node's histograms written in JS. Values are counted exactly, so above 2047 a percentile can differ from Node's 3-significant-figure HDR buckets.

**`v8`:** heap and code statistics (approximate), `cachedDataVersionTag`, `setFlagsFromString` (changes nothing), `startupSnapshot` (never building one), `isStringOneByteRepresentation`, and the coverage no-ops. `serialize`/`deserialize`, heap snapshots and `queryObjects` need V8's own bindings: they throw `ERR_NOT_SUPPORTED`.

## Modules that are not available

| Module | What `require` does |
|---|---|
| `dgram`, `wasi` | throws `ERR_NOT_SUPPORTED` |
| `test`, `sqlite`, `sea` | throws `ERR_UNKNOWN_BUILTIN_MODULE` |

**`cluster`** is Node 22.22.0's primary: `isPrimary`, `workers` (none), `settings`, `setupPrimary`/`setupMaster` with its `'setup'` event, `schedulingPolicy`, `disconnect`, and the `Worker` class. That's enough for prom-client's `AggregatorRegistry`. A worker would be a `child_process.fork` with an IPC channel, which jsh doesn't have, so `cluster.fork()` throws `ERR_NOT_SUPPORTED` when it's called (golden `cluster-trace-events-node22`).

**`trace_events`** is Node's: `createTracing` and its checks, `Tracing` objects (`enable`, `disable`, `enabled`, `categories`, and their inspect form), and `getEnabledCategories()` as the agent's sorted set (with `--trace-event-categories`). It also gives Node's warning past 10 enabled objects. There's no trace agent, so no trace file is written.

**`worker_threads`** is the main thread's view: `isMainThread` true, `parentPort` and `workerData` null, `threadId` 0, environment data, `BroadcastChannel`, `MessageChannel`, `MessagePort` and `receiveMessageOnPort`. A `Worker` can't be made yet (`ERR_NOT_SUPPORTED`).

**`MessageChannel` and `MessagePort`** are Node 22's, within one program, and are also the globals:
- A message is a structured clone (an `ArrayBuffer` in the transfer list is transferred; a `MessagePort` in it goes as itself, in `ports`). Its `MessageEvent` comes on a later turn.
- The first `'message'` listener (`onmessage`, `on()`, `addEventListener()`) starts the port and refs it; until then messages wait, and `receiveMessageOnPort` takes them synchronously. A started port with a listener keeps the program alive until it's closed or `unref()`'d, as in Node.
- `close()` closes both ends: what was posted before is delivered, then each end gets `'close'`. `new MessagePort()` is `ERR_CONSTRUCT_CALL_INVALID`.
- A port is a NodeEventTarget: `on`, `once`, `off`, `emit` and the rest, where a `'message'` listener gets the data.

**Order of port messages.** BroadcastChannel and MessageChannel share Node's order. In one turn (Node's poll phase), each port, in the order the ports were made, takes its messages one per task, with a handler's ticks and microtasks run before the next. The turn comes before the program's immediates (Node's check phase) and after a timer that was already due. A port the turn has yet to reach takes a message posted during it, and one it has passed takes it on the next turn. A message posted from an immediate waits for the immediates already queued.

**`BroadcastChannel`** is Node 22's, within one program:
- Channels of one name get each other's messages: a structured clone, delivered as a `MessageEvent` on a later turn, to each channel in the order the channels were made. A channel never gets its own messages.
- `close()`, `ref()`/`unref()`, `onmessage`, and Node's errors are as in Node. An open channel keeps the program alive.
- Separate programs never hear each other, as separate Node processes don't.
- It never touches the platform's `BroadcastChannel`, which the kernel withholds on purpose because it would reach other contexts of the origin.
- It is the global on slicc-kernel 1.92.0 and later, where the lockdown leaves the slot writable. Before that the kernel's lockdown fixes the global as a non-writable, non-configurable `undefined`, which jsh can't replace or remove: `typeof BroadcastChannel` is `'undefined'`, `new BroadcastChannel()` is the platform's `TypeError: BroadcastChannel is not a constructor`, and `require('worker_threads').BroadcastChannel` has the working one.
