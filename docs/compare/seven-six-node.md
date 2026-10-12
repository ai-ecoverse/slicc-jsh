# `.jsh` in seven vs six vs Node: gap report

Status: **measurement only** (phase 1). Nothing in slicc-jsh is changed yet; this report proposes the fixes.

**Bottom line.** The `.jsh` wrapper itself already agrees with six and Node: the async body, top-level `await`/`return`, the parameters, `require` resolution and `sliccy:cli/fmt/time/pool/http` are the same everywhere. The big gaps sit elsewhere:

- **Deliberate breaks** whose script migration hasn't happened: v6's promise `fs` (45 scripts) and whole-buffer `stdin.read()` (7).
- **A catchable `process.exit`.** Seven inherited it from six, and Node doesn't have it. 40 scripts carry a workaround, and the `--help` of about 10 scripts exits 1 on both.
- **Three seven runtime bugs with outsized effects:**
  - `process.nextTick` doesn't run while the body is pending, which hangs every awaited stream, child process and socket;
  - in-flight `fetch`/`exec` don't keep the program alive;
  - `rmdirSync` deletes non-empty directories.
- **Builtins seven doesn't have yet:** `zlib`, `crypto`, sync `child_process`, `readline`, `tty`.

## How this was measured

| | version | how it ran |
|---|---|---|
| six | SLICC 6.247.17, `ai-ecoverse/slicc@e44ee9d2c` (origin/main, 2026-10-11) | the real v6 shell and realm, headless under slicc's own vitest setup (see below) |
| seven | slicc-jsh `main@06e7bb5` (child_process from #58 and #62 included), slicc-kernel 1.59.1 | the kernel `jsh` on slicc-kernel's Node entry, with `@ai-ecoverse/wasm-bash@5.3.0-17` and `wasm-coreutils@9.12.0-5` installed |
| jsh | same build | the host `jsh` (`dist/host/jsh.mjs`) on Node 22.22.0: the `.jsh` wrapper on real Node, the reference for `.jsh` semantics |
| node | Node 22.22.0 | each case as a plain program (ESM, or CJS where the body needs it): the tie-breaker for the Node API |

The harness is [test/compare/](../../test/compare/README.md):
- 127 cases;
- the recorded outputs in [results/](../../test/compare/results);
- a mechanical summary in [results/SUMMARY.md](../../test/compare/results/SUMMARY.md);
- `node test/compare/show.mjs <case>` prints one case on all four systems.

The case name is given for every row below.

**How six runs.** The most faithful headless path is the repo's own: `AlmostBashShellHeadless` over a fake-indexeddb `VirtualFS`, which is how `tests/shell/ipk/*-e2e.test.ts` drive `.jsh` today.
- The case is written to `/workspace/skills/jshc/` (a default `$PATH` root), and the shell runs `main <args>`. That is `.jsh` discovery → `jsh-executor` → `runInRealm` → `runJsRealm`, with v6's module graph, esbuild lowering, fs bridge, sync-fs cache and just-bash `exec`.
- With no `Worker` under vitest, the realm is `realm-inprocess.ts`: the same `runJsRealm`, minus the thread.
- I picked this over:
  - `cjs-realm-harness.ts`, which skips the shell, the VFS and `exec`;
  - `npx sliccy` over CDP, which needs a browser and an LLM-free way to type commands, and gives no better fidelity for the realm code.
- I ran it on a clean worktree of origin/main. The local `~/Developer/ai-ecoverse/slicc` checkout is at 6.99.9 and has stale `.js` files next to the `.ts` sources, which vite picks up.

**What the six column can't show.** The in-process realm uses the test process's own globals. Rows that depend on that are marked *(harness)* and judged from v6's code:
- unhandled rejections: `realm-unhandled-rejections.ts` listens on the worker's global scope, and Node's global never fires;
- `child_process.*Sync`: needs the Service Worker sync bridge;
- native `import()` inside `new Function`;
- `globalThis.process`;
- the exact set of browser globals.

**What seven's Node entry can't show** (not covered, and not driven on https://seven.sliccy.ai either):
- `sliccy:browser`: `@ai-ecoverse/sliccy-browser` isn't installed in the test kernel, and there is no CDP target;
- `oauth-token`, `webhook`, `playwright-cli`;
- a real terminal: every run here has stdout on a pipe;
- the browser transport: in the Node entry, `fetch('http://127.0.0.1:…')` reaches the *host's* loopback, while `http`/`net` sockets live on the kernel's loopback.

**The corpus.** 87 scripts:
- the 84 `*.jsh` files in `ai-ecoverse/skills@99f93d4` (origin/main; 82 at the `01d62a5` the design doc counted);
- the 3 under `slicc/packages/vfs-root` at `e44ee9d2c`.

[`corpus.mjs`](../../test/compare/corpus.mjs) counts features with regular expressions over the source, so each count means "scripts whose text uses it", an upper bound. The counts are in [`corpus.json`](../../test/compare/corpus.json). The "corpus" column below is that count.

## Verdicts

- `same`: all three agree.
- `seven≠node`: a seven bug; fix toward Node. Six is noted where it agrees with seven.
- `six≠node, seven=node`: a deliberate break; the migration for affected scripts is noted.
- `six-only`: a SLICC v6 feature with no Node counterpart; the proposal is keep, port or drop.
- `unknown`: the harness can't tell.

## Matrix

### The wrapper

| behavior | six | seven | node (host jsh / plain) | verdict | corpus | case |
|---|---|---|---|---|---|---|
| async body, top-level `await`, `for await` | yes | yes | yes / ESM yes | same | 44 | wrapper-top-level-await |
| top-level `return`; `return main()` is waited for | yes | yes | yes / CJS yes | same | 2 | wrapper-top-level-return, wrapper-return-promise |
| parameters `process, console, require, module, exports, fetch, __dirname, __filename` | same 8 | same 8 | same 8 | same | — | wrapper-params |
| `require.main === module`, `module.id === '.'` | `false`, `undefined` | `true`, `'.'` | `true`, `'.'` | six≠node, seven=node | 1 | wrapper-params |
| sloppy body | sloppy, but **strict as soon as the body contains `import(` or `import`** (v6 lowers it to CJS) | sloppy | sloppy | six≠node, seven=node | 4 | wrapper-sloppy, wrapper-strict-after-import |
| `#!` line ignored, BOM dropped | yes | yes | yes | same | 1 | wrapper-shebang, wrapper-bom |
| stack frames name the script and its line | no (`eval at construct (…just-bash…), <anonymous>:4:10`) | `/…/main.jsh:2:10` | same | six≠node, seven=node | — | error-line-numbers, wrapper-shebang |
| static `import … from` | lowered to CJS; `__filename` then undefined | SyntaxError | SyntaxError / works as ESM | six-only (0 scripts): keep the SyntaxError | 0 | wrapper-static-import, wrapper-static-import-sliccy |
| `import('./x.mjs')`, `import('pkg')`, `import('node:fs')` | yes | yes | yes | same (seven and six also list `value` as a named export of a CJS `module.exports = { value }`; Node lists only `default`) | 4 | import-relative, import-package, import-builtin |
| `import('sliccy:exec')` | works | `Cannot find module 'sliccy:exec'` | `ERR_UNSUPPORTED_ESM_URL_SCHEME` | six-only; the two jsh engines fail differently | 0 | require-sliccy-esm |
| `import('https://…')` (pdf, pptx2pdf use esm.sh) | `Cannot find module … (run: ipk install http:)` | `MODULE_NOT_FOUND` | `ERR_UNSUPPORTED_ESM_URL_SCHEME` | same (all reject; those 2 scripts are broken on six today too) | 2 | import-url |
| `new Function('u', 'return import(u)')` (vpod) | unknown *(harness)* | `ERR_ACCESS_DENIED` for `node:path`; relative paths resolve against a `data:` URL | works | seven≠node | 1 | import-in-function-ctor |
| syntax error report | message only | `SyntaxError: …`, no file:line | file:line, caret, message | seven≠node (cosmetic) | — | wrapper-syntax-error |

### `process`

| behavior | six | seven | node | verdict | corpus | case |
|---|---|---|---|---|---|---|
| `argv[1]`, `argv.slice(2)`, non-enumerable `parseFlags()` and its output | same | same | same (jsh) | same | 57 / 40 | process-argv, process-parse-flags |
| `argv[0]` | `'node'` | `'jsh'` | `process.execPath` | seven≠node, documented in the design; harmless, since all 8 mentions skip it | 8 | process-argv |
| `argv0`, `execArgv` | undefined | present | present | six≠node, seven=node | — | process-argv |
| `process.env.X = 42` stays a number | yes | yes | coerced to `'42'` | seven≠node (six too) | 32 | process-env |
| `exec()` children see the script's env (caller's and `process.env` edits) | **no** (just-bash's shell env) | yes | yes | six≠node, seven=node | 42 | exec-env-inherit |
| `process.chdir` | missing | works; a missing directory doesn't throw | throws `ENOENT` | seven≠node (minor) | 0 | process-cwd-chdir |
| **`process.exit()` can be caught** (`NodeExitError`): `catch`/`finally` run, code after it runs, `--help` inside `await main().catch(e => cli.die(e.message))` exits 1 with `Process exited with code 0` | yes | yes | no: exits at once | **seven≠node** (six too) | 54 exit, 51 `cli.die`, 45 `cli.help`; 11 caught-main shape; 72 with `try/catch`; 40 carry a `NodeExitError` re-throw guard | process-exit-catchable, process-exit-in-catch-all, process-exit-in-async-catch, sliccy-cli, sliccy-cli-help-in-main-catch |
| extra `jsh: Process exited with code 1` on stderr after `process.exit` in a `.catch` | no | **yes** | no | seven≠node | 11 | error-in-main-catch, process-exit-in-async-catch |
| `exitCode`, `exit()` with no argument, `exit` in a timer after the body | same | same | same | same | 54 | process-exit-code, process-exit-noarg, process-exit-in-timer |
| `exit` from a timer while the body is still awaiting | hangs | exits | exits | six≠node, seven=node | — | process-stdout-write-cb |
| 200 KB of stdout, then `exit(0)` | complete | complete | complete | same | 21 | process-exit-flush |
| `on('exit')`, `on('beforeExit')` | no `process.on` | yes | yes | six≠node, seven=node | 0 | process-exit-event |
| `process.kill(process.pid, 'SIGTERM')` with a handler | no `on`/`kill` | kills itself (143); handler ignored | handler runs | seven≠node | 0 | process-signals |
| `pid`, `hrtime`, `nextTick`, `memoryUsage`, `umask`, … | mostly missing | present; missing `ppid`, `emitWarning`, `versions.v8`, `release`; `toString` is `[object Object]` | all | seven≠node (minor) | 1 | process-props |
| `stdout.write(s, cb)` calls `cb` | **never** (the script hangs) | yes | yes | six≠node, seven=node | 21 | process-stdout-write-cb |
| `stdout/stderr/stdin.isTTY` on pipes | `true, true, false` (`= !NO_COLOR`) | `false, false, false` | `undefined` ×3 | seven≠node (cosmetic; falsy either way) | 2 | process-stdout-istty |
| `stdout.write(42)` | — | accepted | TypeError | seven≠node (minor) | — | process-stdout |
| `console.log(true, 42)` under `FORCE_COLOR=1` | plain | plain | coloured | seven≠node (minor) | — | stdout-isatty-color |

### `process.stdin`

| behavior | six | seven | node | verdict | corpus | case |
|---|---|---|---|---|---|---|
| `process.stdin.read()` / `await process.stdin.read()` at start | the whole buffer | `null` | `null` | six-only, deliberate break: migrate | 7 | stdin-read, stdin-read-await |
| `read()` with nothing piped | `null` | `null` | `null` | same | — | stdin-read-empty |
| `'data'`/`'end'` with `setEncoding`, `for await`, a Promise collector | same | same | same | same | 8 | stdin-events, stdin-async-iterator, stdin-text-helper |
| `'data'` chunks without `setEncoding` | strings | Buffers | Buffers | six≠node, seven=node | 2 | stdin-events-buffer |
| `fs.readFileSync(0, 'utf8')` | yes | yes | yes | same (the portable form) | 0 | stdin-fd0 |
| `readline.createInterface({ input: process.stdin })` | yes | `'readline' is not supported yet` | yes | seven≠node | 0 | stdin-readline |

### Exit timing and errors

| behavior | six | seven | node | verdict | corpus | case |
|---|---|---|---|---|---|---|
| timers pending when the body returns (300 ms, 2.5 s) | run | run | run | same | 33 | exit-pending-timer, exit-long-timer |
| floating `main().catch()` whose main awaits a timer | waits | waits | waits | same | 1 | wrapper-floating-main |
| **in-flight `fetch` / `exec` when the body returns** | waits | **exits 0, output lost** | waits | **seven≠node** | 1 floating main (signal.jsh), plus any fire-and-forget I/O | exit-pending-fetch, exit-floating-main-fetch, exit-floating-main-exec |
| cleared interval plus an `unref()`'d one | hangs | exits | exits | six≠node, seven=node | 2 | exit-interval-cleared |
| body awaits a promise that never settles, loop empty | hangs | **hangs** | host jsh exits 0; plain ESM exits 13 with a warning | seven≠node | — | exit-never-settles |
| uncaught Error from the body | `err.stack`, status 1 | `err.stack`, status 1 | host jsh: `err.stack`; plain Node: source excerpt, then `inspect(err)` with its own properties and `cause`, then `Node.js v22.22.0` | same between the engines; the `.jsh` layer drops `code`/`cause` that Node prints | — | error-uncaught, error-uncaught-props, error-cause |
| uncaught Error from a timer | **swallowed**; later timers still run; status 0 | Node's format, status 1 | status 1 | six≠node, seven=node | 33 | error-in-timer |
| unhandled rejection; a rejection handled one macrotask later | unknown *(harness; v6's code prints the stack and exits 1)* | Node's format, status 1 | status 1 | seven=node; six unknown | — | error-unhandled-rejection, error-rejection-late-handled |
| `throw 'string'` / `throw {…}` | `just a string` / `[object Object]` | same | host jsh same; plain Node prints `inspect()` | same between the engines | — | error-throw-string, error-throw-object |

### `require`

| behavior | six | seven | node | verdict | corpus | case |
|---|---|---|---|---|---|---|
| order: `sliccy:` first, builtins beat `node_modules/path`, `node_modules/sliccy-cli` doesn't shadow | same | same | same | same | 54 | require-shadow-builtin |
| `./x.js`, `./x`, `./x.cjs`, `./lib.jsh`, `./x.json`, `./dir`, cycles, cache | same | same | same | same | 18 / 3 `.jsh` | require-relative |
| `require(__dirname + '/x.cjs')` (computed specifier) | **fails**: v6's module graph is built from string literals before the run | works | works | six≠node, seven=node | 2 absolute (literal) | require-absolute |
| `node_modules`: `main`, `exports`, subpaths, scoped, nested | same | same, but the `slicc` condition wins | same | seven≠node **by design** (the `slicc` condition) | 4 packages | require-node-modules |
| `require.resolve`, `require.cache` | missing | yes | yes (`sliccy:` aside) | six≠node, seven=node | — | require-resolve |
| missing package | no `code`; `(run: ipk install x)` | `MODULE_NOT_FOUND` | `MODULE_NOT_FOUND` | six-only: drop the hint (or port it as a hint line) | 4 | require-missing |
| native packages (`sharp`, `better-sqlite3`, `puppeteer`, `usb`) | refused with a hint naming a SLICC alternative | `MODULE_NOT_FOUND` | `MODULE_NOT_FOUND` | six-only: drop | 0 | require-native |
| `require('playwright')` with nothing installed | CDP shim | `MODULE_NOT_FOUND` | `MODULE_NOT_FOUND` | six-only: decide | 1 (intent-arm) | require-playwright |
| `require(esm)` | yes; top-level-await message differs | yes; no `__esModule` on the namespace | yes | seven≠node (minor) | — | require-esm |
| builtins served (of Node 22's 53 names) | 20 (no `http`, `https`, `net`, `string_decoder`, `querystring`, `timers*`, `stream/*`, `util/types`, `perf_hooks`, `async_hooks`, …) | 25; **missing: `crypto`, `zlib`, `readline`, `tty`, `vm`, `worker_threads`, `dns`, `http2`, `tls`, `dgram`, `cluster`, `perf_hooks`, `async_hooks`, `stream/web`, `stream/consumers`, `readline/promises`, `path/win32`, `v8`, `inspector`, …** | all | seven≠node | 2 crypto, 3 zlib, 2 child_process | require-builtins |
| `sliccy:agent/usb/serial/hid/computer` | served | `only available inside SLICC` | n/a | six-only, by design | 0 / 1 / 0 / 0 / 1 | require-sliccy-unknown |

### `fs`

| behavior | six | seven | node | verdict | corpus | case |
|---|---|---|---|---|---|---|
| `await fs.readFile(p)` with no callback (and `writeFile`, `mkdir`, `readdir`, `stat`, `rm`, `appendFile`) | promises; `readFile` gives a **string** without an encoding | Node: `ERR_INVALID_ARG_TYPE` (callback required) | same | six≠node, seven=node (decision 1): **migrate** | **45** (35 `await fs.readFile`) | fs-readfile-await, fs-writefile-await |
| `await fs.exists(p)` | boolean | TypeError | TypeError | six-only: migrate to `existsSync` | 16 | fs-exists |
| `readFileBinary`, `writeFileBinary`, `readDir`, `fetchToFile` | yes | missing | missing | six-only: migrate | 22 / 9 / 2 | fs-v6-extras |
| `(await fs.stat(p)).isDirectory` as a property | boolean | — | method | six-only: migrate | 6 | fs-stat |
| `fs.promises` / `fs/promises` | `fs.promises !== require('fs/promises')`; `readFile` without an encoding isn't a Buffer; no `open` | identical; missing `mkdtemp` and `FileHandle.readFile` | full | seven≠node (minor) | 1 | fs-promises |
| callbacks (`readFile(p, 'utf8', cb)`, …) | work | work | work | same | 0 | fs-callbacks |
| the sync calls the corpus uses (`writeFileSync`, `readFileSync`, `mkdirSync`, `existsSync`) | same | same | same | same | 10 | fs-sync |
| other sync calls | `readdirSync` withFileTypes broken; `mkdirSync` of an existing dir silent | missing `copyFileSync`, `realpathSync`, `mkdtempSync`, `cp`, `rm` (async), `chmod*`, `truncate*`, `utimes*`, `watch*`, `Stats`, `ReadStream`, `WriteStream`; `readdirSync({ recursive })` not recursive; `statSync(…, { throwIfNoEntry: false })` throws; `mkdirSync({ recursive })` returns `undefined` | all | seven≠node | — | fs-sync, fs-surface, fs-stat |
| **`rmdirSync` on a non-empty directory** | `ENOTEMPTY` | **deletes it, contents and all** | `ENOTEMPTY` | **seven≠node (data loss)** | 0 | fs-errors |
| error objects | `code` only; `EISDIR`/`ENOTDIR` reported as `ENOENT` | Node's `code`/`errno`/`syscall`/`path`/message | full | six≠node, seven=node | 55 | fs-errors |
| encodings: `readFileSync(p, 'latin1'/'base64')`, `writeFileSync(p, 'ff00', 'hex')` | encoding ignored | `latin1`/`base64` decoded as UTF-8; `hex` ignored | right | seven≠node | 0 direct (16 use `Buffer`) | fs-binary |
| binary bytes through `readFileSync`/`writeFileSync` | right | right | right | same | 16 | fs-binary |
| file descriptors: `openSync`/`readSync`/`closeSync`; `writeFileSync(1)`; `/dev/stdout`, `/dev/null` | no `openSync`; fd 1/2 and `/dev/std*` work | fds work; `writeFileSync(1)` → `EIO`; `/dev/stdout` and `/dev/null` → `ENOENT` | all | seven≠node | — | fs-fd |
| `createReadStream` / `createWriteStream` / `pipe` | missing | **hangs** (nextTick, below) | works | seven≠node | 0 | fs-streams |
| coherence: promise write → `readFileSync`; `writeFileSync` → promise read; shell ↔ fs | **async writes invisible to sync reads** (also `writeFileBinary`, `fetchToFile`, `skill.config()` writes) | coherent | coherent | six≠node, seven=node | 10 | fs-coherence, fs-v6-extras, sliccy-skill |
| `/workspace`, `/shared` exist | `/workspace` only (`/tmp` and `$HOME` missing in a fresh VFS) | no / no | no / no | environment | 14 / 17 / 13 `/tmp` | env-paths |

### Other builtins

| behavior | six | seven | node | verdict | corpus | case |
|---|---|---|---|---|---|---|
| `child_process.exec/spawn/execFile` (async) | works | works when the body doesn't await it; **hangs when it does** (nextTick) | works | seven≠node | 2 | child-process-async, child-process-floating |
| `execSync`, `execFileSync`, `spawnSync` | unknown *(harness: needs the SW sync bridge)* | `not supported yet` | works | seven≠node | 2 | child-process-sync, process-env-to-child |
| `crypto` | md5/sha1/sha256 only; no `createHmac`, `pbkdf2Sync`, `timingSafeEqual`, `getHashes` | `'crypto' is not supported yet` | full | seven≠node | 2 (plus 5 using the global `crypto`, which works everywhere) | crypto, globals-crypto |
| `zlib` | sync and callback (pako); no brotli, no streams | `'zlib' is not supported yet` | full | seven≠node | 3 | zlib |
| `stream`: `Readable.from`, `pipeline`, `stream/promises` | stubs | **hangs** | works | seven≠node | 1 | stream |
| `events` | no `once()`, `prependListener` or `setMaxListeners`; emitting `'error'` doesn't throw | no `prependListener`, `setMaxListeners`, `captureRejections` | full | seven≠node (npm deps call `setMaxListeners` a lot) | 0 | events |
| `util` | no `types`, `isDeepStrictEqual`, `TextDecoder` | no `parseArgs`, `styleText`, `callbackify` | full | seven≠node | 0 | util |
| `os` | no `userInfo`, `totalmem`, `networkInterfaces`, `constants` | no `userInfo`, `networkInterfaces`, `constants`, `availableParallelism` | full | seven≠node | 2 | os |
| `path` | `path.posix !== path`, no `win32` | no `win32`, `toNamespacedPath`, `matchesGlob` | full | seven≠node (minor) | 5 | path |
| `url` | no `parse`, `format`, `resolve` | no `format`, `resolve` | full | seven≠node | 0 | url |
| `Buffer` | right | **`subarray()` copies instead of sharing memory**; no `buffer.constants`, `buffer.Blob` | right | seven≠node | 9 `subarray`, 16 `Buffer` | buffer |
| `http`/`https`/`net`: a server on 127.0.0.1 and a client | refused (`Use fetch()`) | **hang** | work | seven≠node | 0 | http-module, net |
| `tty.isatty` | `false` ×3 | `'tty' is not supported yet` | `false` ×3 | seven≠node | 0 | tty |
| `assert`, `string_decoder`, `querystring`, `timers/promises`, `module.createRequire` | partial | work | work | same for seven | 0 | misc-builtins |
| `perf_hooks`, `async_hooks`, `worker_threads`, `vm`, `dns` | refused | missing or `not supported yet` | work | seven≠node | 0 | misc-builtins |

### `console`

| behavior | six | seven | node | verdict | corpus | case |
|---|---|---|---|---|---|---|
| `console.log(obj)`, `%s`/`%d`/`%o`, `Map`, `Error`, `Buffer`, nested depth | **`JSON.stringify`**: `{"a":1}`, no format specifiers, `Map` → `{}`, `Error` → `{}`, `undefined` in arrays → `null` | `util.inspect`, identical to Node | inspect | six≠node, seven=node | 64 use `console.log`, a handful log non-strings | console-format |
| `console.table`, `dir`, `group`, `count`, `assert` | `table`/`dir` print JSON | same as Node; **`console.trace` missing** | full | seven≠node (minor) | 0 | console-methods |

### `sliccy:` modules

| behavior | six | seven | node | verdict | corpus | case |
|---|---|---|---|---|---|---|
| `cli.out/warn/help/die`: streams, prefixes, codes | same | same | same (host jsh) | same (exit semantics: see `process.exit`) | 54 | sliccy-cli, sliccy-cli-help, sliccy-cli-die-object |
| `color` on a pipe with no `NO_COLOR`/`FORCE_COLOR` | **on** | off | off | six≠node, seven=node (decision 4) | 40 | sliccy-color-pipe |
| `NO_COLOR=1`, `FORCE_COLOR=1` | same | same | same | same | 40 | sliccy-color-no-color, sliccy-color-force |
| `fmt`, `time`, `pool` | same | same | same | same | 22 / 2 / 0 | sliccy-fmt-time-pool |
| `exec(cmd)`, `exec.spawn(argv)`: result shape, stderr, codes, pipes, quoting, 127 | same; not-found text `bash: …` | same; `jsh: line 1: …` | same as seven | same | 42 / 20 | sliccy-exec |
| `exec.start()` kill | `124`, `bash: execution aborted` | `143` | `143` | six-only detail | 2 | sliccy-exec-start |
| `http.client` | same | same (also exports `HttpError`) | same | same | 8 | sliccy-http |
| `skill.dir`, `config()`, `token()` → `oauth-token` | same | same | same | same | 27 / 20 / 4 | sliccy-skill |
| **`skill.refs` / `skill.assets` for `scripts/x.jsh`** | `<skill>/references`, `<skill>/assets`, plus `skill.root` | `<skill>/scripts/references`, `<skill>/scripts/assets`, no `root` | n/a | **seven≠six**: no Node counterpart, so fix toward six | 2 | sliccy-skill |
| `sliccy:browser` | the bridge (no browser here: `browser is not available in this runtime`) | unknown name unless `@ai-ecoverse/sliccy-browser` is installed | n/a | unknown for real seven | **37** | sliccy-browser |

### Globals

| behavior | six | seven | node | verdict | corpus | case |
|---|---|---|---|---|---|---|
| web and Node globals (`fetch`, `WebSocket`, `Buffer`, timers, `structuredClone`, streams, `crypto`, …) | present *(harness: Node's set)* | present; no `BroadcastChannel` | present | same | 46 fetch, 16 Buffer, 31 URL, … | globals |
| `SLICC_VERSION` / `process.versions.jsh` | set / unset | unset / set | unset / set (jsh) | six-only / by design | 0 / 0 | globals |
| `fetch`: JSON, text, 404, POST, FormData, bytes, headers | same | same | same | same | 46 | fetch |
| `fetch`: redirect reporting, `redirect: 'manual'`, `AbortSignal`, error type | `redirected: false`, manual ignored, abort ignored, `Error` (not `TypeError`) | Node's | Node's | six≠node, seven=node | 5 AbortController | fetch |
| `WebSocket` echo | works | works | works | same | 0 | websocket |
| **`process.nextTick` while the body (or an ESM entry's top-level await) is pending** | no `nextTick` | **queued, but only run after the body settles** | runs | **seven≠node**: the cause of every stream, `child_process`, `http`/`net` and fs-stream hang above, and it hits `node` ESM with top-level await too (checked by hand: `node m.mjs` in the kernel prints a `nextTick` queued before an `await` last) | 0 direct; every npm package on streams | timers |
| `setImmediate`, timer handles (`unref`/`ref`/`hasRef`), extra `setTimeout` args | same | same | same | same | 33 | timers, timers-immediate |

## Proposed fixes, ordered by corpus impact

Default: follow Node. "Where" means one of:
- the **runtime** (`src/runtime/`, shared with `node`);
- the **`.jsh` layer** (`src/jsh/`);
- a **`sliccy:` module**;
- the **kernel**;
- **scripts** (a migration in ai-ecoverse/skills).

1. **`process.exit()` ends the program at once** (also `cli.die`, `cli.help`).
   - **Where:** runtime. `Process.exit` throws `NodeExitError` (`src/runtime/process.mjs`), and user code catches it like any error. This is the runtime, so `node` scripts in seven can catch it too (checked by hand).
   - **The fix:** stop the program without unwinding through user code: flush stdio, run `'exit'` listeners, end the process. That may need a kernel primitive, a `ctx.exit` that doesn't return or unwind (today `ctx.exit` throws `JsExit`). In the same change, drop the stray `jsh: Process exited with code N` line.
   - **Why:** 11 scripts have the `await main().catch((e) => cli.die(e.message))` shape. On both six and seven their `--help` prints help, then `<tool>: Process exited with code 0`, and exits 1. 72 scripts mix exits with `try/catch`. 40 scripts carry a hand-written `if (err?.name === 'NodeExitError') throw err` guard, "MANDATORY re-throw", which becomes dead but harmless code.
   - **Risk:** 16 scripts have a `finally` block and also exit. Under Node, an exit inside such a `try` skips the `finally`, for example `playwright-cli stop-recording`/`tab-close` or `releaseLock`. **Decision for Lars (D1).**
2. **Migrate v6's promise `fs`** (decision 1, already made).
   - **Where:** scripts.
   - **What:** use `fs.promises` with explicit encodings, `existsSync` for `fs.exists`, `readFile(p)` returning a Buffer for `readFileBinary`, `readdir` for `readDir`, `fetch` plus `writeFile` for `fetchToFile`, and `stat().isDirectory()` as a method.
   - **Why:** 45 scripts (35 `await fs.readFile`, 16 `exists`, 22 binary, 9 `readDir`, 2 `fetchToFile`, 6 `isDirectory` properties). All of them fail on seven today with `The "cb" argument must be of type function`.
   - The migrated code runs on six as well, except for one thing: six's async writes aren't visible to its sync reads (row "coherence"), so the migration should not mix the two on six.
   - An optional `sliccy:fs` compatibility module would let the migration be mechanical. **Decision for Lars (D2).**
3. **Keep the program alive while `fetch`, `exec`/`exec.spawn`/`exec.start` and fs promises are in flight.**
   - **Where:** runtime handles (track them as ref'd handles, as timers are).
   - **Why:** signal.jsh's floating `main().catch()` and any fire-and-forget I/O exit 0 with their output silently lost. It is the worst failure mode: a success status with no work done.
4. **Run `process.nextTick` callbacks while `main` (the `.jsh` body) or an ESM entry's top-level await is pending.**
   - **Where:** runtime, `src/runtime/run.mjs`. It awaits `options.main(rt)` and `esm.runMain` before `drainLoop` ever runs `nextTick.flushSync()`.
   - **Why:** this one bug is behind the hangs in `stream`, `fs.createReadStream`, `http`, `net` and awaited `child_process`. Direct corpus use is small (2 `child_process`, 1 `stream`), but every npm package built on streams hangs, and the 4 scripts that `require` packages (eslint, remotion, pptx2pdf, intent) are exposed. The same bug affects `node` ESM scripts with top-level await, which likely matters for the cert as well.
5. **Migrate whole-buffer `process.stdin.read()`.**
   - **Where:** scripts. Use `fs.readFileSync(0, 'utf8')`, or collect `'data'` into a Promise.
   - **Why:** 7 scripts: gh, bb, wrangler, pangram, icloud, kev, cua-s1. On seven they get `null`, as on Node.
   - The alternative is keeping v6's non-Node `read()` in the `.jsh` layer. **Decision for Lars (D3).**
6. **`sliccy:browser` in seven.**
   - **Where:** packaging. Make sure seven installs `@ai-ecoverse/sliccy-browser` (slicc-cdp#40).
   - **Why:** 37 scripts. Not measurable on the Node entry; it needs a check on real seven.
7. **Builtins seven doesn't have yet.**
   - **Where:** runtime.
   - **What, in corpus order:**
     - `zlib` (3: pandoc, pdf-text, make-fixtures);
     - `crypto` (`createHash` and `createHmac` at least; 2: tiktok, make-fixtures);
     - sync `child_process` (2);
     - `readline` and `tty` (0 in the corpus, common in packages);
     - the `events` methods `setMaxListeners` and `prependListener` (packages);
     - `util.parseArgs`, `url.format`/`resolve`, `os.userInfo`, `path.win32`, `console.trace`.
   - **Why:** they're Node, and the corpus and its packages use them.
8. **`fs` correctness in seven.**
   - **Where:** runtime `fs`, and the kernel for `/dev/null` and `/dev/stdout`.
   - **What, in order of harm:**
     1. `rmdirSync` deleting non-empty directories;
     2. `readFileSync` encodings (`latin1`, `base64`) and `writeFileSync` encodings (`hex`);
     3. `writeFileSync(1)` (`EIO`), and `/dev/null` and `/dev/stdout` (`ENOENT`);
     4. the missing calls (`copyFileSync`, `realpathSync`, `mkdtempSync`, async `rm`, `cp`, `truncate`, `utimes`, `chmod`, `fsp.mkdtemp`, `FileHandle.readFile`);
     5. `readdirSync({ recursive })`, `throwIfNoEntry`, and the return value of `mkdirSync({ recursive })`.
   - **Why:** 55 scripts use `fs`, and once item 2 lands they all run on this one.
9. **`Buffer.prototype.subarray` shares memory.**
   - **Where:** runtime Buffer.
   - **Why:** 9 scripts call `subarray`. A silent copy only matters when they write through it, but it is wrong and cheap to fix.
10. **`skill.refs`/`skill.assets` relative to the skill root, plus `skill.root`.**
    - **Where:** `sliccy:skill` (`src/jsh/sliccy/exec.mjs` `createSkill`).
    - **Why:** 2 scripts today, and the convention for every skill under `scripts/`. There's no Node counterpart, so six is the reference.
11. **`process.env` assignments coerce to strings.**
    - **Where:** runtime.
    - **Why:** 32 scripts use `process.env`. A child would otherwise see `"42"` where the script sees `42`.
12. **A body that never settles.**
    - **Where:** the kernel `jsh` (`.jsh` layer and runtime).
    - **What:** seven hangs forever, where the host jsh exits 0 and Node ESM exits 13 with `Warning: Detected unsettled top-level await`. Make the two jsh engines agree; which way is **decision D4**.
    - **Why:** a hang costs the agent a timeout.
13. **Smaller Node gaps in seven:**
    - `process.kill(self, sig)` honours handlers;
    - `chdir` to a missing directory throws;
    - `isTTY` is `undefined` (not `false`) off a TTY;
    - `stdout.write(non-string)` throws;
    - `FORCE_COLOR` colours `console.log`;
    - `process.ppid`/`emitWarning`/`release`;
    - `__esModule` on `require(esm)`;
    - `import()` inside `new Function` (vpod) resolves like the body's `import()`.
14. **`.jsh` layer consistency:**
    - `import('sliccy:x')`: six supports it, while the two jsh engines fail with different errors; make both support it or both reject it the same way;
    - the uncaught-error format: both engines print `err.stack`, Node prints `inspect(err)` with `code`/`cause` and a source excerpt (D5).
    - 0 corpus scripts.
15. **Six-only features: proposals.**
    - Drop:
      - the `ipk install` hint (or port it as an extra line on `MODULE_NOT_FOUND`);
      - the native-package refusal list;
      - static-`import` lowering (0 scripts; keep seven's SyntaxError);
      - `SLICC_VERSION` (seven has `process.versions.jsh`).
    - Keep, with no Node counterpart: `sliccy:agent/usb/serial/hid/computer` inside SLICC (1 usb, 1 computer).
    - Decide: the `playwright` CDP shim (1 script, intent-arm), D6.

Things seven already does better than six and should keep, since all of them follow Node:
- `exec()` children inherit the script's env;
- `console` uses `util.inspect`;
- errors from timers are fatal;
- `stdout.write` callbacks are called;
- `require.resolve` works;
- computed `require()` specifiers work;
- sync and async fs are coherent;
- stack frames name the script.

## Decisions for Lars

- **D1. `process.exit` semantics.** Exiting at once (Node) fixes `--help` in about 11 scripts and makes 40 workaround guards dead code. But exits inside `try { … } finally { cleanup }` would skip the cleanup (16 scripts have both). Options:
  - (a) Node semantics, and review those 16 scripts' cleanups (move them to `process.on('exit')` or before the exit); **recommended**;
  - (b) keep the throw, and only stop `catch` blocks from seeing it (not possible in plain JS).
- **D2. A `sliccy:fs` compatibility module for the 45 v6-`fs` scripts?** Decision 1 says migrate. A shim would make the migration a one-line `require` change, at the cost of a non-Node API living on.
- **D3. `process.stdin.read()` returning the whole buffer** (7 scripts): migrate, or keep a non-Node `read()` in the `.jsh` layer?
- **D4. A body that never settles:** exit 0 silently (what the host jsh does today), or Node's exit 13 with its warning? Seven must pick one of the two; today it hangs.
- **D5. Uncaught-error output:** keep `err.stack` (both engines, today), or print what Node prints (`code`, `cause`, source excerpt, `Node.js vX`)?
- **D6. The `playwright` shim** (intent-arm): port it to seven over CDP, or tell the script to use `sliccy:browser` or `playwright-cli`?
- **D7. Ownership of a non-unwinding exit** (fix 1) and of `/dev/null` and `/dev/stdout`: slicc-jsh or slicc-kernel?

## Rows the harness couldn't settle (unknown)

- six: unhandled rejections, `child_process.*Sync`, `import()` inside `new Function`, `globalThis.process`, the browser global set (in-process realm; see above).
- seven: `sliccy:browser` and `playwright-cli` over CDP, `oauth-token`, the browser network transport, and real terminal runs (TTY colour, `isTTY: true`, `columns`). These need a session on real seven.
