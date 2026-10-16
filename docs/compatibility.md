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

**CommonJS.** `require` resolves as Node does: `node_modules`, `package.json` `"exports"` and `"imports"`, `node:` builtins, JSON. The module wrapper is Node's five-argument form. `process`, `Buffer` and the timers are real globals. Modules resolve through symlinks to their real path, unless `--preserve-symlinks` (or `--preserve-symlinks-main`). `module.createRequire`, `Module._extensions`, `Module.builtinModules` and `isBuiltin` are there.

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
- `https` always goes through `fetch`.

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
- `'response'` comes at the head, and the body streams as it arrives: by `Content-Length`, chunked, or until the peer's FIN. `socket.end` half-closes.
- `http.Agent` follows Node's `_http_agent.js` request path (`addRequest` → `createSocket` → `createConnection`), so **agent-base** subclasses work for plain `http`. `getName`, `destroy`, `keepSocketAlive`, `reuseSocket`, `removeSocket`, and `sockets`/`freeSockets`/`requests` are present.
- `http.globalAgent` keeps sockets alive, as in Node 22 (`keepAlive: true`, `scheduling: 'lifo'`, `timeout: 5000`). An agent with `keepAlive` reuses a socket once its response is done (`'free'`, then `req.reusedSocket`), queued requests first. As in Node 22, a server's `Keep-Alive: timeout=N`, less `agentKeepAliveTimeoutBuffer` (1 s), caps a free socket's timeout, and a hint that leaves nothing (`timeout=1`) means the socket isn't reused. Free sockets don't keep the program alive, and one the server closes leaves the pool. `agent: false`, or an agent without `keepAlive`, sends `Connection: close`.
- A connection that closes before its response gives `socket hang up` (`ECONNRESET`). A `101` response is `'upgrade'` (response, socket, head), and without a listener the connection closes.

**The fetch fallback** (plain `http` without a route, and every `https` request). The request is sent once it has ended, through jsh's `fetch`: the embedder's transport, and `host.slicc.internal` through the kernel's proxy. What a fetch can't carry, it doesn't:
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

**`https` client.** `https.request` and `https.get` take the fetch fallback above every time.
- `ClientRequest` is an `EventEmitter`, not a stream.
- `cert`, `key`, `pfx` and `ca` throw `ERR_NOT_SUPPORTED`: no client certificates or custom CAs.
- `rejectUnauthorized: false` is accepted but ignored. TLS verification stays on.
- Redirects: requests use `redirect: 'manual'`, so a redirect shows as `statusCode` and `Location`, as in Node. On the browser entry the transport may refuse that with `ENOTSUP`; jsh then falls back to `'follow'`, so plain requests work but a redirect is followed instead of surfaced. The Node entry's transport supports manual redirects. Embedders with `traits.redirectHops` ([slicc-kernel#315](https://github.com/ai-ecoverse/slicc-kernel/issues/315)) can surface redirects in the browser.

**Not available:** `https.createServer` throws `ERR_NOT_SUPPORTED`, as does anything in `tls` that needs a handshake (below).

## `tls`

`require('tls')` and `import … from 'node:tls'` load with Node 22.22.0's exports, so a package that requires `tls` at load runs as long as it doesn't make a TLS connection. **ws** is one: its `ws://` server over an `http` server's `'upgrade'`, and its client, run as in Node. **agent-base**, **http-proxy-agent** and **https-proxy-agent** load too, but loading is all: https-proxy-agent's tunnel needs `tls.connect`, and http-proxy-agent fails at request time even over a plain `http://` proxy, because jsh's `ClientRequest` has no `_implicitHeader()` ([#323](https://github.com/ai-ecoverse/slicc-jsh/issues/323)).

The kernel's sockets (`ctx.net`) have no TLS, so whatever needs a handshake throws `ERR_NOT_SUPPORTED` (`slicc-jsh: '<what>' is not supported yet (no TLS on ctx.net)`, as `https.createServer` does) when it's called, not when the module loads:
- `tls.connect`, after Node's checks of `checkServerIdentity` and `minDHSize`.
- `listen()` on a `tls.Server`.
- `new tls.TLSSocket(socket)` over a socket, and `connect()` on a `TLSSocket`.
- `createSecureContext` (and so `createServer`) with key material: `ca`, `cert`, `key`, `pfx`, `crl`, `dhparam`, a private-key engine or a client-certificate engine. Each one's type is checked first, as Node checks it.
- `createSecurePair`, which is deprecated (DEP0064).

What doesn't need a handshake is Node's:
- `checkServerIdentity`: Node's matching (wildcards, the CN fallback, quoted altnames, IP addresses compared in canonical form), returning `ERR_TLS_CERT_ALTNAME_INVALID` with `reason`, `host` and `cert`, or throwing `ERR_TLS_CERT_ALTNAME_FORMAT`.
- `convertALPNProtocols`, `getCiphers()` (Node 22.22.0's list, from its OpenSSL), `DEFAULT_CIPHERS`, `DEFAULT_ECDH_CURVE`, `DEFAULT_MIN_VERSION`, `DEFAULT_MAX_VERSION` (both follow `--tls-min-v1.x`, `--tls-max-v1.x` and `--tls-cipher-list`), `CLIENT_RENEG_LIMIT` and `CLIENT_RENEG_WINDOW`.
- `createSecureContext` and `SecureContext` without key material, with Node's option checks and errors (`ERR_TLS_INVALID_PROTOCOL_VERSION`, `ERR_TLS_PROTOCOL_VERSION_CONFLICT`, …).
- `TLSSocket` extends `net.Socket`, and `Server` extends `net.Server` (callable without `new`, as in Node), so `instanceof` checks and subclasses work. `new tls.TLSSocket()` without a socket has `encrypted: true` and `authorized: false`, and its session getters answer as Node's do before a handshake (`getPeerCertificate()` is `null`, `exportKeyingMaterial` is `ERR_TLS_INVALID_STATE`). A `tls.Server` keeps its options, contexts (`addContext`) and ticket keys.

**`rootCertificates` is an empty frozen array**, and so are `getCACertificates('bundled')`, `'system'` and `'extra'`. jsh makes no TLS connection of its own (an `https` request goes through `fetch`, which uses the platform's trust store), so Node's 146 bundled certificates (about 220 KB) would be trust anchors nothing in jsh uses. `setDefaultCACertificates` checks its arguments as Node does and keeps the list as given, which `getCACertificates()` returns.

The golden `tls-node22` checks the export list and these behaviours against Node 22.22.0.

## `fetch` and `WebSocket`

`globalThis.fetch` and `globalThis.WebSocket` run on the kernel's `ctx.fetch` and `ctx.websocket`. A request in flight keeps the program alive, and so does reading its body. `new WebSocket` checks its URL and protocols as Node 22's does: `http:` and `https:` become `ws:` and `wss:`, another scheme, a fragment, a duplicate or a non-token protocol is a `SyntaxError` `DOMException`, and `.url` is the parsed URL.

**Loopback.** As with Node on a machine, a loopback URL reaches a server of *this* kernel. The loopback names are `127.0.0.0/8`, `::1`, `0.0.0.0`, `localhost`, `*.localhost` and `<port>.kernel.localhost`. jsh does the HTTP over the kernel's sockets on every kernel. A `ws:` URL goes to the kernel's own loopback `ctx.websocket` on slicc-kernel 1.106.3 and later, which answers as undici does ([slicc-kernel#822](https://github.com/ai-ecoverse/slicc-kernel/issues/822)). On older kernels jsh does the WebSocket handshake and framing over the kernel's sockets itself. Either way, `new WebSocket(process.env.SLICC_CDP_URL)` reaches the kernel's CDP facade on 127.0.0.1:9222, and the loopback WebSocket holds the server to RFC 6455 as undici does. The one difference between the two is the message of a refused upgrade's `event.error.cause` (`… with 503 Service Unavailable` from the kernel, `… with 503` from jsh).
- A loopback redirect to another origin drops `authorization`, `proxy-authorization`, `cookie` and `host`.
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

**Not available:** Brotli and Zstd throw `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. Their callback forms (`brotliCompress(buf, cb)`, …) pass it to the callback.

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

**`async_hooks`** has `AsyncResource` (including `bind` and `runInAsyncScope`, under which `executionAsyncId()` is the resource's), `createHook` (its hooks never run), `executionAsyncId`/`triggerAsyncId` and `asyncWrapProviders`. That's enough for `events.EventEmitterAsyncResource`. **`new AsyncLocalStorage()` throws `ERR_NOT_SUPPORTED`**, because the runtime can't carry its store across an `await`.

**`domain`** is Node's own `lib/domain.js`. It follows a domain into the ticks, timers and immediates queued inside it, which is where Node's async hooks take it. A throw there is the domain's `'error'`, and so is an emitter's `'error'`. Promise jobs are the gap: the runtime can't see them, so a rejection isn't routed to a domain.

**`diagnostics_channel`** is Node's own, `tracingChannel` included.

**`perf_hooks`:**
- `performance` and the `Performance*` classes are the program's own, and `constants` are Node's.
- `createHistogram` and `monitorEventLoopDelay` are Node's histograms written in JS. Values are counted exactly, so above 2047 a percentile can differ from Node's 3-significant-figure HDR buckets.

**`v8`:** heap and code statistics (approximate), `cachedDataVersionTag`, `setFlagsFromString` (changes nothing), `startupSnapshot` (never building one), `isStringOneByteRepresentation`, and the coverage no-ops. `serialize`/`deserialize`, heap snapshots and `queryObjects` need V8's own bindings: they throw `ERR_NOT_SUPPORTED`.

## Modules that are not available

| Module | What `require` does |
|---|---|
| `cluster`, `http2`, `dns`, `dns/promises`, `dgram`, `inspector`, `inspector/promises`, `trace_events`, `wasi` | throws `ERR_NOT_SUPPORTED` |
| `test`, `sqlite`, `sea` | throws `ERR_UNKNOWN_BUILTIN_MODULE` |

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
