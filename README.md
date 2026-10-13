# @ai-ecoverse/slicc-jsh

A Node.js-compatible runtime for [slicc-kernel](https://github.com/ai-ecoverse/slicc-kernel): the `node` and `jsh` commands, built on the kernel's `abi: "js"` programs.

Design and milestones: [slicc-kernel#68](https://github.com/ai-ecoverse/slicc-kernel/issues/68). Running `jsh` outside SLICC (host Node, CDP): [docs/design/run-outside-slicc.md](docs/design/run-outside-slicc.md) (#20).

## Status

**0.2.0** — ships M2 net/http/https, M3 ESM, and host `jsh` (#22). Requires `slicc-kernel` ≥ 1.53.2 (Buffer `allocUnsafe` leak fix; 1.53.3 is the certified kernel). Published to npm `latest`.

**M1 shipped (0.1.0-8)** — Node-entry lockdown ([slicc-kernel#297](https://github.com/ai-ecoverse/slicc-kernel/issues/297)): CJS wrapper is Node's 5-arg form; `process` / `Buffer` / timers are real globals; vendor stream/string_decoder share jsh's Buffer class; StringDecoder accepts TypedArrays; timer stacks keep script URLs. Certified on hb2.

**M2 shipped:** `globalThis.fetch` / `WebSocket` from kernel ≥ 1.53.0 `OPEN_SLOTS` (`ctx.fetch` / `ctx.websocket`). `net` / `http` on `ctx.net` (loopback TCP); `https.createServer` waits on TLS, `https.request`/`get` use `ctx.fetch` with `redirect: 'manual'` (Node entry) and fall back to `'follow'` on browser transports that reject manual redirects (`ENOTSUP`). jsh `Buffer.allocUnsafe` / `allocUnsafeSlow` zero-fill and `poolSize` is `0`.

**WebSocket refused connects** need `slicc-kernel` ≥ **1.59.1** on the Node entry (`nodeTransport` / `fetchTransport`). When `ctx.websocket` rejects, jsh emits an `error` Event (no `close`; `readyState` stays `CONNECTING`), matching Node 22 undici. The rejection's `err.cause.code` is passed through on `error.error.cause` (`ECONNREFUSED`, `EAI_NONAME`, `EHOSTUNREACH` / `ENETUNREACH`, `ETIMEDOUT`, `EPROTO`); Node undici's own `ErrorEvent.error` has no `.code` / `.cause`, so jsh does not invent one on the event. `ws://host.slicc.internal:port` reaches the host loopback. Do not probe with `ctx.net.connect` before open: that dials the **kernel** loopback, while `nodeTransport` WebSockets reach the **host**'s `127.0.0.1`.

**M3 shipped:** ESM — `.mjs` / `"type":"module"`, static `import`/`export`, dynamic `import()`, `import.meta.url` / `import.meta.resolve`, and CJS↔ESM interop (`import` of CJS, `require` of ESM, `package.json` `"exports"` `import`/`require` conditions). The transform uses **acorn** (bundled) so multi-line imports/exports, strings/comments, and `$` identifiers parse correctly; imports are hoisted and export getters are registered before evaluation for cycles. Node-style detect-module for `-e` / ambiguous `.js` (dynamic `import()` alone stays CJS).

**Host jsh (#22):** package `bin` is `dist/host/jsh.mjs` — run `.jsh` on host Node 22+ with the same body scope and `sliccy:` modules as in the kernel.

**HTTP/HTTPS limits (M2):** request and response bodies are buffered whole until `end()` when no `Content-Length` is set (then sent with a computed length); with `Content-Length`, body bytes stream as written. No chunked transfer encoding / SSE yet — multi-write responses still flush as one payload. Bodies over 64 MiB are rejected (`413` on the server, `ERR_OUT_OF_RANGE` on the client). `http.Agent` follows Node's `_http_agent.js` request path (`addRequest` → `createSocket` → `createConnection`) so **agent-base** / http(s)-proxy-agent subclasses work; `getName`, `destroy`, `keepSocketAlive`, `reuseSocket`, `removeSocket`, and `sockets` / `freeSockets` / `requests` are present. Keep-alive pooling is not implemented (`keepAlive` is accepted, `req.reusedSocket` is always `false`). `https.request` options `cert` / `key` / `pfx` / `ca` throw `ERR_NOT_SUPPORTED` (no client certs / custom CA on `ctx.fetch`). `rejectUnauthorized: false` is accepted but ignored — TLS verification stays stricter than Node with that flag. Responses with no `Content-Length` and no chunked encoding wait for the peer's FIN (`socket.end` half-closes via `writer.close()` only). On the **browser** entry, `https.get` tries `redirect: 'manual'` and falls back to `'follow'` when the transport rejects it with `ENOTSUP` — so plain requests work, but a redirect may be followed instead of surfaced (`statusCode` / `Location`). The Node entry's `nodeTransport` supports manual redirects. Embedders with `traits.redirectHops` (kernel #315) can surface redirects in the browser.

**npm ecosystem gaps:** The `tls` module itself is unsupported (`ERR_NOT_SUPPORTED`) — so **http-proxy-agent** / **https-proxy-agent** (which import `tls` for CONNECT tunnels) cannot run yet even though `http.Agent` subclasses via agent-base work for plain `http`.

**`child_process` (0.3.0):** `spawn`, `execFile`, and `exec` (via `sh -c`) sit on `ctx.spawn` — argv/env/cwd, stdio `inherit`/`pipe`/`ignore`, streams on `.stdin`/`.stdout`/`.stderr`, events `spawn`/`exit`/`close`/`error` (ENOENT), `.kill(signal)`, `.pid`. The sync forms (`spawnSync`, `execSync`, `execFileSync`) are Node 22's own option handling and result/throw shapes on slicc-kernel 1.65.0's `ctx.sync.run`: `encoding`, `input`, `stdio` (`pipe`/`ignore`/`inherit`, the program's own fds and terminal included), `shell` (`/bin/sh`), `cwd`, `env`, `timeout`/`killSignal` (`ETIMEDOUT`), `maxBuffer` (`ENOBUFS`), `ENOENT` on `.error`, and `execSync`/`execFileSync` throwing with `status`/`signal`/`stdout`/`stderr`/`output`/`pid`. On an older kernel they throw `ERR_NOT_SUPPORTED` naming the kernel version needed. A stdio slot can be another fd: on slicc-kernel 1.70.0+ the program's own fds go straight to the child and stdout and stderr sent to one fd keep the child's write order; an fd from `fs.openSync` (jsh's own) is written after the run. On older kernels every other fd is written after the run, stdout before stderr. `argv0` only changes error messages (the kernel runs `argv[0]`), and stdio slots past fd 2 are not passed to the child. `fork` stays `ERR_NOT_SUPPORTED`. Also `fs.realpathSync` and `process.getuid`/`getgid`/`kill(self)` so pnpm's global cmd shims can resolve their target and re-raise signals. As of 0.3.3, pipe stdio loads `readable-stream` from sources embedded in the bundle (not a sync read of `/node_modules/@ai-ecoverse/slicc-jsh/dist/vendor/…`), so `pnpm add -g` installs under `$PNPM_HOME/global/v11/<hash>/` work on seven.

**`fs` and symlinks:** `cp`, `cpSync` and `promises.cp` follow Node 22.22's own code, quirks included. They're tested byte for byte against Node (golden fixtures `fs-cp-sync`, `fs-cp-async`, `fs-readdir-links`):
- A symlink in a copied tree stays a symlink, with its target made absolute unless `verbatimSymlinks`. A linked directory is never descended into.
- `cpSync(src, dest, { recursive: true, dereference: true })` still copies a tree's symlinks as symlinks. That's Node 22.22's native `CpSyncCopyDir`. Only `fs.cp`/`promises.cp` (Node's `cp.js`) really dereference.
- `readdirSync({ recursive })` and `promises.readdir({ recursive })` with names descend into linked directories. `promises.readdir` with `withFileTypes` and `opendir({ recursive })` don't.
- `realpathSync` resolves every link.
- `linkSync` is the kernel's: it works on `tmpfs`, and fails with `EPERM` on the root file system and `fsa`, and with `EXDEV` across mounts.

**`zlib`:** browserify-zlib 0.2.0 (Node's own `zlib.js` port) over pako 1.0.11. The vendor bundle is minified and only evaluated by the first `require('zlib')`. It's patched to Node 22: option validation and its errors, ArrayBuffer and TypedArray input, `{ info: true }`, `destroy`/`close`, `params`, and raw-inflate dictionaries. Also `constants`/`codes` from Node 22 and `crc32`. Deflate output is byte-identical to Node's (golden `zlib-node22`). Brotli and Zstd have no implementation here: they throw `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`, and their callback forms (`brotliCompress(buf, cb)`, …) pass it to the callback.

**`crypto`:** Node 22's own JS layer (`lib/internal/crypto/{hash,cipher,keys,pbkdf2,hkdf,scrypt,random}.js`, ported) over pure-JS primitives in a minified vendor bundle that's only evaluated by the first `require('crypto')`. The primitives are @noble/hashes 1.8.0 (digests, HMAC, PBKDF2, HKDF, scrypt) and browserify-aes 1.2.0 / browserify-des 1.0.2 (block ciphers). Random numbers, `webcrypto` and `subtle` come from the platform's WebCrypto. Available:
- `createHash`/`hash` for md5, sha1, sha2, sha3, shake, ripemd160, blake2, sm3 (on noble's Merkle–Damgård base) and md5-sha1, under OpenSSL's names and aliases; md4, mdc2 and whirlpool (OpenSSL's legacy provider) fail with `ERR_OSSL_EVP_UNSUPPORTED`, as in Node 22;
- `createHmac`, `pbkdf2`, `hkdf` and `scrypt`, each sync and async;
- `createCipheriv`/`createDecipheriv` for AES ECB/CBC/CFB/CFB8/CFB1/OFB/CTR/GCM and 3DES;
- secret `KeyObject`s (`createSecretKey`, `generateKey`);
- the `random*` family, `timingSafeEqual`, `getCiphers`/`getCipherInfo`/`getHashes`, and `constants`.

Outputs and errors match Node 22.22.0 (golden `crypto-node22`). That includes Node's quirks, such as "Deriving bits failed" for a zero-length PBKDF2 or HKDF key. DES (single), Blowfish and the other ciphers in OpenSSL's legacy provider fail as `unsupported`, as in Node 22. Asymmetric keys, sign/verify, DH/ECDH, RSA encryption, primes, X509, and the CCM/OCB/XTS/ChaCha20/wrap ciphers have no implementation here: they throw `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` (`crypto.subtle` covers much of it). The callback forms (`generateKeyPair`, `generatePrime`, `checkPrime`) check their callback as Node does and pass that error to it.

**stdio and `tty`:** `process.stdin`, `process.stdout` and `process.stderr` are Node's streams, made on first access: a `stream.Readable` and `stream.Writable`s, so `pipe`, `stream.pipeline`, async iteration, `'data'`/`'end'`, `setEncoding` and `pause`/`resume` work.
- On a terminal they're `tty.ReadStream` and `tty.WriteStream`:
  - `isTTY`;
  - `setRawMode` (the kernel's raw mode, put back when the program ends);
  - `columns`/`rows`, with `'resize'` on `SIGWINCH`;
  - `getColorDepth`/`hasColors` (Node's own `internal/tty.js`);
  - `cursorTo`/`moveCursor`/`clearLine`/`clearScreenDown`.
- Off a terminal they have no `isTTY`, as in Node.
- **Paused stdin:** reading stdin keeps the program alive only while something consumes it, so a paused stdin lets the program end.
- **`tty.isatty(fd)`:** answers for fds 0–2, which the runtime asks the kernel about before the program starts. Any other fd is `false`.
- **Signals:** a `process.on('SIGINT' | 'SIGTERM' | 'SIGWINCH' | …)` listener installs a kernel signal handler. Removing the last listener puts the default action back. `SIGKILL`/`SIGSTOP` throw `uv_signal_start EINVAL`.
- **Install timing:** the kernel installs a handler a moment after `process.on` returns, whereas Node does it synchronously. `setRawMode` likewise takes effect a moment after it returns (a key typed in between is still echoed).

**`path`, `url`, `querystring`, `punycode`, `os`:** Node v22.22.0's own `lib/path.js` (`win32` included; `matchesGlob` over minimatch 10.0.3, the version Node vendors), `lib/url.js` (legacy `parse`/`format`/`resolve`, `fileURLToPath`/`pathToFileURL` with `windows`, `domainToASCII`/`domainToUnicode`, `urlToHttpOptions`), `lib/querystring.js`, `lib/punycode.js` and `lib/os.js`, in `src/node-lib`. What they ask Node's C++ for comes from `src/runtime/node-bindings.mjs`:
- `os.userInfo()` is the kernel's `/etc/passwd` entry;
- `os.constants` holds Linux's values;
- `os.networkInterfaces()` lists the kernel's loopback;
- `os.availableParallelism()` and `os.cpus()` come from `navigator.hardwareConcurrency`.

The WHATWG `URL` is the platform's.

**`events`:** Node v22.22.0's own `lib/events.js` (in `src/node-lib`). It is the EventEmitter of `require('events')` and of every emitter in the runtime: `process`, streams (readable-stream uses it, so `new Stream()` is an EventEmitter), child processes, servers and agents. That brings `newListener`/`removeListener`, `prependListener`, `errorMonitor`, `captureRejections`, `setMaxListeners` and the `MaxListenersExceededWarning`, `events.once`/`events.on` with `AbortSignal`, `getEventListeners`, `listenerCount` and `EventEmitter.call(this)` for old-style subclasses. The platform's own `EventTarget`/`AbortSignal` have none of Node's internals, so `getEventListeners` and `getMaxListeners` don't accept them.

**`process` and the program's end (Node 22):**
- `process.exit()` (and so `cli.die`, `cli.help`, a fatal `kill(self)`) ends the program at once: on slicc-kernel 1.65+ through `ctx.sync.exit`, so no `catch`, `finally`, microtask or timer of the program runs after it, as in Node. On older kernels the code it unwinds through still runs, silenced (no output, no further status change).
- `'exit'` listeners run first on every way out (the end of the loop, `process.exit()`, an uncaught error, an unhandled rejection), and the `process.exitCode` they leave is the status. On an uncaught error they run before its report, and a `process.exit()` in one ends the program without it.
- `process.kill(process.pid, sig)` delivers to `process.on(sig)` listeners on a later turn (like Node's signal handles it doesn't keep the program alive); with none, the program ends at once with 128 + n and no `'exit'`. Its argument errors (`ESRCH`, `EINVAL`, `ERR_UNKNOWN_SIGNAL`) are Node's.
- `process.chdir` throws Node's `ENOENT`/`ENOTDIR` errors; `process.ppid` comes from the kernel; `process.versions` lists what the runtime has or mirrors (no openssl, brotli, …).
- `node --input-type=module|commonjs` for `-e` and piped input. ES module input is `<cwd>/[eval1]`, as in Node (`import.meta.url`, `filename`, `dirname`); `import.meta.resolve` gives a missing file's URL rather than throwing.
- `require()` of an ES module with a default export returns Node's facade with `__esModule: true` (live bindings), or its `'module.exports'` export.
- `import()` inside `new Function`/`AsyncFunction` bodies loads through the runtime, resolved against the calling script.

**`util`, `console`, `async_hooks`:** Node v22.22.0's own `lib/util.js` and console (`lib/internal/console/{constructor,global}.js`, `internal/cli_table`), with `internal/util/{types,debuglog,colors,diff,comparisons,parse_args}` and `internal/mime`, in `src/node-lib`. This brings `parseArgs`, `styleText`, `MIMEType`, `parseEnv`, `getSystemErrorName`/`Map`/`Message` (libuv's errors with Linux numbers), the full `util.types`, `isDeepStrictEqual` (Node's comparisons), `debuglog` (`NODE_DEBUG`), `diff`, the deprecated `util.is*`, and the whole console: `Console`, `timeLog`, colours as Node's `shouldColorize` decides them, and the inspector-only `profile`/`profileEnd`/`timeStamp`/`context`/`createTask`, which do nothing here. `util.inspect` is still node-inspect-extracted, with Node 22's symbol-key and `byteLength` output.

`async_hooks` has `AsyncResource` (including `bind` and `runInAsyncScope`, under which `executionAsyncId()` is the resource's), `createHook` (its hooks never run), `executionAsyncId`/`triggerAsyncId` and `asyncWrapProviders`. That's enough for `events.EventEmitterAsyncResource`. `new AsyncLocalStorage()` throws `ERR_NOT_SUPPORTED`, because the runtime can't carry its store across an `await`.

**`Buffer` encodings:** as in Node 22's `lib/buffer.js`. `from`, `toString`, `write`, `fill` and `indexOf`/`lastIndexOf`/`includes` throw `ERR_UNKNOWN_ENCODING` for an encoding Node doesn't know (`byteLength` counts it as UTF-8, as Node does). base64 decoding is forgiving, `ascii` drops the high bit, and `write` never writes part of a character.

**Warnings:** `process.emitWarning` is Node's own `internal/process/warning.js`. It prints `(node:PID) [CODE] Name: message`, the first time with its `--trace-…` hint, and emits `'warning'`. `util.deprecate` warns once per code, as Node's does. `--no-warnings`, `--no-deprecation`, `--trace-warnings`, `--trace-deprecation`, `--throw-deprecation`, `--disable-warning=CODE`, `--redirect-warnings=FILE` and `NODE_NO_WARNINGS=1` work as in Node.

**`readline`:** `readline` and `readline/promises` are Node v22.22.0's own `lib/readline` (in `src/node-lib`). That covers `createInterface` over any stream, `question`, `for await (const line of rl)`, `emitKeypressEvents`, the cursor helpers, and on a terminal raw-mode line editing with history, completion, `^C` (`'SIGINT'`) and `^D`. The `readline-node22` golden matches Node's bytes, escape sequences included. `node --expose-internals` makes the internal modules carried in `src/node-lib` requirable (for Node's own tests).

**Still later:** `tls` / `worker_threads` / TLS `https.createServer` throw `ERR_NOT_SUPPORTED` until their milestone.

JS program entries are **esbuild-bundled** to single files (`dist/node.mjs`, `dist/jsh.mjs`) because the kernel loads `abi: "js"` modules via `data:` URLs (relative imports do not resolve).

## Commands

| Command | Module | Notes |
|---|---|---|
| `node` | `dist/node.mjs` | Node 22.x-compatible entry |
| `jsh` | `dist/jsh.mjs` | `.jsh` scripts; binfmt maps `.jsh` → `jsh` |

## `jsh` outside SLICC

The package's `bin` is the host `jsh` (`dist/host/jsh.mjs`), which runs `.jsh` scripts on the host's own Node 22+. Inside slicc-kernel (a global `pnpm add -g` puts this `bin` on `PATH` ahead of the kernel's `jsh`), it hands off to the kernel jsh instead:

```bash
npm i -g @ai-ecoverse/slicc-jsh
jsh script.jsh args…          # or ./script.jsh with #!/usr/bin/env jsh
npx @ai-ecoverse/slicc-jsh script.jsh
```

A `.jsh` file is the body of an async function with `process`, `console`, `require`, `module`, `exports`, `fetch`, `__dirname` and `__filename` in scope, the same in the kernel and on the host. `require('fs')` is Node's `fs`. Built-in `sliccy:` modules are `cli`, `color`, `exec`, `fmt`, `http`, `pool`, `skill` and `time`. Any other `sliccy:<name>` resolves to an `@ai-ecoverse/sliccy-<name>` or `sliccy-<name>` package; `sliccy:browser` over CDP comes from slicc-cdp ([slicc-cdp#40](https://github.com/ai-ecoverse/slicc-cdp/issues/40)). The parity tables are in the [design note](docs/design/run-outside-slicc.md#parity-tables).

## Develop

```bash
npm ci
npm run build
npm run lint
npm run test:golden          # host Node 22 baselines (npx node@22)
npm run test:jsh             # .jsh parity: host jsh baseline vs kernel jsh
npm run test:integration     # slicc-kernel Node entry, memory root
```

Golden fixtures live under `test/golden/fixtures/` and are **not** published (`files` allowlists `dist` only). Record baselines with Node 22:

```bash
npm run golden:record
npm run jsh:record           # .jsh cases under test/jsh/fixtures/, recorded with the host jsh
```

## Release

Releases are cut by [semantic-release](https://semantic-release.gitbook.io/) on every push to `main` (`.github/workflows/release.yml`, the shared `node-release.yml` from slicc-shared-web), as in the sibling repos. It runs `npm run lint` and `npm test` (golden, `.jsh` parity, kernel integration), then derives the version from the commits since the last `v*` tag:
- a `feat:` commit gives a minor release (0.x stays 0.x until a breaking change);
- a `fix:` or `perf:` commit gives a patch release;
- other types (`chore:`, `docs:`, `ci:`, `test:`, `merge:`, …) release nothing.

It publishes to npm `latest` with trusted publishing (OIDC) and provenance, and creates a GitHub release. The published `package.json` carries no `prepare`/`prepack`: `prepack` builds and then runs `scripts/strip-own-scripts.mjs`, which removes both from the checkout in CI before npm packs (a local `npm pack` keeps them). `version` in `package.json` stays `0.0.0`; semantic-release sets the real one when it publishes. npm has to trust `release.yml` for this package once: `npm run trust` (fledgling) sets that up, and `npm run trust:dry` shows what it would do.
