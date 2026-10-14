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
- `--max-old-space-size=N` and `--trace-uncaught` are accepted. The kernel sets a program's memory, and the uncaught report is the usual one.
- A bad value for a V8 flag gets V8's report, followed by Node's `bad option` lines.
- Options after `-e`/`-p` are still node's, up to the first argument.
- `NODE_OPTIONS` is read as Node 22 reads it: words with spaces, quotes and escapes; only the options Node allows there; its options before the command line's and out of `execArgv`; Node's errors.
- Boolean options take `--x` and `--no-x`, and the last form wins. A value that looks like an option counts as missing (`--require --no-warnings`).
- Also: the [warning flags](#warnings), `--enable-source-maps`, `--preserve-symlinks`, `--preserve-symlinks-main`, `--expose-internals`, `--title`, `--pending-deprecation` and the `--report-*` options (they set `process.report`).
- `-c`/`--check` is accepted but doesn't check: the script runs.
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

**Signals and `kill`.**
- `process.kill(process.pid, sig)` delivers to `process.on(sig)` listeners on a later turn. Like Node's signal handles, they don't keep the program alive. With no listener, the program dies of the signal at once: status 128 + n, no `'exit'`. Its argument errors (`ESRCH`, `EINVAL`, `ERR_UNKNOWN_SIGNAL`) are Node's.
- On slicc-kernel 1.72.0 and later, `process.kill(process.pid | 0 | -pgid, sig)` and `process.abort()` end the program inside the call, through `ctx.sync.kill`, and `kill` reaches other processes. On older kernels the program unwinds, silenced, and another pid gives `ESRCH`.
- SIGPIPE is ignored from the start, as in Node, so a write to a pipe whose reader is gone fails with `EPIPE`. stdout and stderr are never really destroyed (Node's `dummyDestroy`): every failed write emits `'error'` again. `console` swallows only the first one, so a program that keeps logging to a dead pipe ends with status 1, as Node's does. Removing the last `'SIGPIPE'` listener brings back the default action (death by the signal, 141).

**Other members.**
- `process.chdir` throws Node's `ENOENT`/`ENOTDIR` errors. `process.ppid` comes from the kernel.
- `process.env` stores strings, as Node's does.
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

**Modes, owners and times.** The kernel's JS file system has no mode bits, owners or times to set. `chmod`, `chown` and `utimes`, with their `l` and `f` forms, check their arguments and that the path exists, as Node's do, and change nothing.

**`mkdir`** without `recursive` checks that the path doesn't exist and then creates it. These are two steps, not one exclusive call, so two programs racing for the same name can both succeed. A missing parent is created rather than giving `ENOENT`. `recursive: true` works as in Node.

**New files' modes.** `mkdir`, `writeFile` and `open` ignore their `mode` argument: new files are 0666 and directories 0777, less the kernel's umask.

**Not available:** `watch`, `watchFile`, `unwatchFile`, `glob`, `globSync`, `promises.glob`, `promises.watch`, `openAsBlob`, `readv`, `writev`, `fs.Dir` as an export (`opendir` works), and `promises.constants`.

## `child_process`

**Async.** `spawn`, `execFile` and `exec` (through `sh -c`) run on the kernel's `ctx.spawn`:
- argv, env and cwd; Node's errors for a bad `cwd` and for a missing command (`ENOENT`);
- stdio `inherit`, `pipe` and `ignore`, with streams on `.stdin`, `.stdout` and `.stderr`;
- the events `spawn`, `exit`, `close` and `error`; `.kill(signal)`; `.pid`.

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

**Where they reach.** `net` and `http` are TCP on the kernel's sockets (`ctx.net`). That is the kernel's own loopback, IPv4 only. A plain-`http` request to another host fails; use `fetch` or `https` for the network. A server is reachable from other programs in the kernel and, as `<port>.kernel.localhost`, from the page.

**`net`.** Servers and sockets, `allowHalfOpen`, `end()` as a half-close. Unix domain sockets (`path`) and `new net.Socket({ fd })` throw `ERR_NOT_SUPPORTED`.

**`http` server.**
- Request bodies are read whole before the `'request'` handler runs. A body over 64 MiB gets `413 Payload Too Large`.
- Responses stream, as Node's: a `write()` before `end()` (or `flushHeaders()`) sends the head and each chunk as it comes, chunked unless a `Content-Length` is set. SSE and long-poll servers work. `end()` alone sends one framed response.
- Headers can't change once the head is sent (`ERR_HTTP_HEADERS_SENT`).
- `http.STATUS_CODES` has only the common codes (21 of Node's 60-odd). A status not in it gets an empty reason phrase unless you pass one.
- Each response says `Connection: close` unless you set the header: no keep-alive.

**`http` client.**
- With a `Content-Length`, request body bytes stream as written. Without one, the body is buffered until `end()` and sent with a computed length. Request bodies aren't sent chunked.
- `'response'` comes at the head, and the body streams as it arrives: by `Content-Length`, chunked, or until the peer's FIN. `socket.end` half-closes.
- `http.Agent` follows Node's `_http_agent.js` request path (`addRequest` → `createSocket` → `createConnection`), so **agent-base** subclasses work for plain `http`. `getName`, `destroy`, `keepSocketAlive`, `reuseSocket`, `removeSocket`, and `sockets`/`freeSockets`/`requests` are present.
- Keep-alive pooling is not implemented. `keepAlive` is accepted; `req.reusedSocket` is always `false`.

**`https` client.** `https.request` and `https.get` run on the kernel's `fetch` (`ctx.fetch`).
- Request and response bodies are buffered whole. `ClientRequest` is an `EventEmitter`, not a stream.
- `cert`, `key`, `pfx` and `ca` throw `ERR_NOT_SUPPORTED`: no client certificates or custom CAs.
- `rejectUnauthorized: false` is accepted but ignored. TLS verification stays on.
- Redirects: requests use `redirect: 'manual'`, so a redirect shows as `statusCode` and `Location`, as in Node. On the browser entry the transport may refuse that with `ENOTSUP`; jsh then falls back to `'follow'`, so plain requests work but a redirect is followed instead of surfaced. The Node entry's transport supports manual redirects. Embedders with `traits.redirectHops` ([slicc-kernel#315](https://github.com/ai-ecoverse/slicc-kernel/issues/315)) can surface redirects in the browser.

**Not available:** `tls` and `https.createServer` throw `ERR_NOT_SUPPORTED`. Because **http-proxy-agent** and **https-proxy-agent** import `tls` for CONNECT tunnels, they can't run.

## `fetch` and `WebSocket`

`globalThis.fetch` and `globalThis.WebSocket` run on the kernel's `ctx.fetch` and `ctx.websocket`. A request in flight keeps the program alive, and so does reading its body.

**Loopback.** As with Node on a machine, a loopback URL reaches a server of *this* kernel. The loopback names are `127.0.0.0/8`, `::1`, `0.0.0.0`, `localhost`, `*.localhost` and `<port>.kernel.localhost`. jsh does the HTTP, and for `ws:` the WebSocket handshake and framing, over the kernel's sockets, because `ctx.fetch` and `ctx.websocket` only reach the transport ([slicc-kernel#510](https://github.com/ai-ecoverse/slicc-kernel/issues/510)). That's how `new WebSocket(process.env.SLICC_CDP_URL)` reaches the kernel's CDP facade on 127.0.0.1:9222. The loopback WebSocket holds the server to RFC 6455 as undici does.
- A loopback redirect to another origin drops `authorization`, `proxy-authorization`, `cookie` and `host`.
- `host.slicc.internal` (and `10.0.2.2`) reach the real machine's loopback, through the kernel's proxy.

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
- A context (`createContext`, `runInContext`, `runInNewContext`) is the object in front of the ECMAScript globals: the names a script declares or assigns go on it. It isn't a separate realm, so its `Object` is the program's.
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
| `worker_threads`, `cluster`, `tls`, `http2`, `dns`, `dgram`, `inspector`, `trace_events` | throws `ERR_NOT_SUPPORTED` |
| `test`, `sqlite`, `sea`, `wasi` | throws `ERR_UNKNOWN_BUILTIN_MODULE` |

The one global that Node 22 has by default and the runtime doesn't is `BroadcastChannel`.
