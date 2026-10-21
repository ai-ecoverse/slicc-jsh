# `jsh` outside SLICC

Status: **decided on 2026-10-10 and shipped in [#22](https://github.com/ai-ecoverse/slicc-jsh/pull/22).** That PR covers H1 and H2 (see "Milestones"). `sliccy:browser` (H3) is [slicc-cdp#40](https://github.com/ai-ecoverse/slicc-cdp/issues/40). Tracks [#20](https://github.com/ai-ecoverse/slicc-jsh/issues/20). Builds on the in-kernel design, [node-shim-on-js-programs.md](https://github.com/ai-ecoverse/slicc-kernel/blob/design/node-shim-on-js-programs/docs/design/node-shim-on-js-programs.md) ([slicc-kernel#68](https://github.com/ai-ecoverse/slicc-kernel/issues/68)).

Goal: a `.jsh` script runs on an ordinary macOS or Linux machine as `jsh script.jsh args…`, or as `./script.jsh` with `#!/usr/bin/env jsh`. On the host, the JavaScript runs on the host's own Node, and `sliccy:browser` drives a real Chrome over CDP. Tables say exactly what matches inside SLICC and what doesn't. A script that sticks to the portable surface runs the same three ways:
- in SLICC v6;
- under the kernel `jsh` (`abi: "js"`);
- under the host `jsh`.

## Decisions (Lars, 2026-10-10)

1. **`fs` is Node's.** There's no compatibility layer for v6's promise-returning `fs`: "the closer to node, the better". Scripts that relied on v6's `fs` move to Node's API.
2. **`sliccy:http` and `sliccy:skill` are built into slicc-jsh**, like `cli`, `color`, `fmt`, `time`, `pool` and `exec`.
3. **`skill.token(id)` only calls `jerk <id> get --reveal`** ([slicc-jerk](https://github.com/ai-ecoverse/slicc-jerk)). There's no fallback to an environment variable and no other command. It called v6's `oauth-token <id>` until [#74](https://github.com/ai-ecoverse/slicc-jsh/issues/74) (2026-10-21). jerk's provider ids are canonical: there are no aliases, so skills use `adobe-aio` and `xai` where v6 had `adobe` and `xai-grok`. A failure throws `skill.token('<id>'): <jerk's stderr>` with jerk's exit code as `err.exitCode`.
4. **Colour depends on whether stdout is a TTY**, everywhere. `FORCE_COLOR` and `NO_COLOR` override.
5. **`sliccy-browser` lives in slicc-cdp** ([slicc-cdp#40](https://github.com/ai-ecoverse/slicc-cdp/issues/40)).

## What a `.jsh` is in v6

In v6 (`packages/webapp/src/kernel/realm/`), a `.jsh` file is the **body of an async function**, run sloppy:
- Its parameters are `process, console, require, module, exports, fetch, __dirname, __filename`, in that order (`runUserCode` in `realm-module-system.ts`). Top-level `await` and `return` therefore work.
- **Static `import`:** if the entry contains `import` declarations or `import()`, v6's module loader lowers the entry to CommonJS before it runs (`transpileEntry` in `shell/ipk/module-loader.ts`), and then runs it strict.
- `process.argv` is `['node', script, ...args]`, with a non-enumerable `parseFlags()`.
- `require` resolves names in this order:
  1. `sliccy:<name>`;
  2. the shim's built-in modules;
  3. refusals for native-addon packages;
  4. shimmed packages (`playwright`);
  5. `node_modules`.
- **`require('fs')` is v6's own `fs`, not Node's.** Calls return promises and take no callbacks:
  - `readFile(p)` resolves to a string;
  - `stat(p)` resolves to `{ isDirectory, isFile, size }` with boolean properties;
  - it adds `readFileBinary`, `writeFileBinary`, `readDir`, `exists` and `fetchToFile`;
  - `fs.promises === fs`;
  - only the `*Sync` calls behave like Node's (`realm-fs-bridge.ts`).
- Stdin is buffered whole, so `process.stdin.read()` returns all of it.
- The script ends when its promise settles. In-flight work then gets a short, bounded grace period, and timers still pending at that point are dropped.
- `globalThis.SLICC_VERSION` is set.

**Existing scripts:** 83 `.jsh` files. 82 are in [ai-ecoverse/skills](https://github.com/ai-ecoverse/skills) at `01d62a5`, and 1 is in slicc's `packages/vfs-root` at `d407a914e`.

| use | scripts |
|---|---|
| `sliccy:cli` / `color` / `fmt` / `time` | 52 / 40 / 22 / 2 |
| `sliccy:exec` | 41 |
| `sliccy:browser` | 35 |
| `sliccy:skill` / `http` | 25 / 9 |
| `sliccy:usb` (no `agent`, `hid`, `serial`, `computer`, `pool`) | 1 |
| `process.argv.parseFlags()` | 56 |
| `require('fs')` | 53 |
| …of these, using v6's promise-returning `fs` (`await fs.readFile(…)`, `fs.exists`, `readFileBinary`, …) | 47 |
| …of these, reading `stat().isDirectory` as a property | 5 |
| `process.stdin` (5 rely on `read()` returning everything) | 9 |
| a literal `/workspace/…` path | 13 |
| top-level `return` / `import()` / static `import` / `#!` | 2 / 4 / 0 / 0 |

Under decision 1, the 47 scripts that use v6's `fs` must migrate. That means `require('fs').promises` (or `fs/promises`) with explicit encodings, `stat().isDirectory()` called as a method, `fs.existsSync`, and so on. The code they end up with is ordinary Node code. It runs under both `jsh`s, and under v6's `*Sync` calls as well.

## Engine options

| | A. host Node (**chosen**) | B. slicc-kernel's Node entry | C. QuickJS |
|---|---|---|---|
| how it works | run the `.jsh` layer on the host's real Node 22+ and its real builtins | boot `@ai-ecoverse/slicc-kernel/node` and run the kernel `jsh` inside it | run slicc-jsh's own runtime on QuickJS, with `ctx` implemented over qjs `std`/`os` |
| Node API fidelity | exact: this *is* Node 22, the reference the shim is certified against | whatever the shim offers | the shim's, plus QuickJS's own gaps |
| commands `exec` can run | real host commands | only wasm commands installed in the kernel | real host commands |
| cost | a launcher plus the shared `.jsh` layer | the README calls the Node entry "a testing entry, not a supported runtime" | a third engine to certify |

**A** is the point of running outside SLICC: the host's files, commands and network, on the Node the shim is measured against.
- **B** is still useful for checking parity: `npm run test:jsh` runs every case under B.
- **C** remains possible later. The runtime only talks to `ctx`, so QuickJS would mean implementing `JsProgramContext` again, not rewriting the runtime. It stays separate from pi-codemode's QuickJS, as #68 asks.

## Design

### One `.jsh` layer, two engines

`src/jsh/` doesn't depend on either engine. It holds:
- `run.mjs`: `jsh`'s own arguments, the `#!` handling, the wrapper and its parameters, `require`, exit rules, and `process.versions.jsh`;
- `parse-flags.mjs`;
- `sliccy/`: the built-in modules and the resolver.

It is used twice:
- **kernel `jsh`** = `src/jsh/` + the `node` runtime on `ctx` (`src/jsh.mjs`);
- **host `jsh`** = `src/jsh/` + real Node (`src/host/main.mjs`, bundled to `dist/host/main.mjs`, behind the `bin` launcher `dist/host/jsh.mjs`).

Each engine passes in what differs:

| | kernel | host |
|---|---|---|
| `readSource` | `ctx.sync.fs.readFile` | `fs.readFileSync` |
| `compile` | `new AsyncFunction` with `//# sourceURL`; `import()` rewritten to the runtime's ESM loader | `vm.runInThisContext` with `USE_MAIN_CONTEXT_DEFAULT_LOADER` |
| `createRequire` | the shim's `module.createRequire` | Node's |
| `selfRequire` (for `sliccy-*` packages) | from `/node_modules/@ai-ecoverse/slicc-jsh` | from slicc-jsh's install location |
| `spawn` | `ctx.spawn` with pipes | `child_process.spawn` |
| `shell` for `exec(cmd)` | `sh -c` (the kernel's `sh` is bash) | `bash -c` if bash is on `PATH`, else `sh -c` |
| `fetch` | `ctx.fetch` | the global `fetch` |
| `stdoutIsTTY` | `ctx.isatty(1)` | `process.stdout.isTTY` |
| `exit` | the runtime's `process.exit` | `process.exit` |

### Wrapper and exit rules (both engines)

1. Read the file as UTF-8. Drop a BOM, and blank a leading `#!…` line so line numbers stay the same.
2. Wrap it as `(async function (process, console, require, module, exports, fetch, __dirname, __filename) {<body>\n})`.
   - Line and column numbers are the file's own: the host compiles the header on a line of its own with a line offset of -1, and the kernel's stack formatting drops `new AsyncFunction`'s header lines.
   - The code runs sloppy, as in v6.
   - A static `import` is a `SyntaxError`; use `await import()`.
3. Call it:
   - `process.argv` is `[runtime, /abs/script.jsh, ...args]` with `parseFlags()`;
   - `module` is a CommonJS module object for the script, `require.main === module`, and `exports === module.exports`.
4. Exit, as for a CommonJS `(async () => { … })()` in Node:
   - The body runs alongside the event loop: ticks, timers and I/O callbacks run while it awaits.
   - The program lives until its event loop is empty. A pending body does not keep it alive by itself, so a body that never settles ends with status 0 (or `process.exitCode`). Requests in flight (`fetch` and its body, `exec`, child processes, sockets, WebCrypto) do keep it alive.
   - When the body throws, that is an unhandled rejection: Node's report (source excerpt, message, `code`/`cause` properties, `Node.js v22…`) goes to stderr and the program exits 1 at once, pending timers included.
   - `process.exit(n)` runs the `'exit'` listeners and ends the program at once; no user `catch` or `finally` sees it. In the kernel the status reaches the kernel at once (`ctx.exit`); whatever still runs while the throw unwinds is silenced (no output, no timers, the first status stays).

**Host.** `vm.runInThisContext` with `importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER` resolves `import('./x.mjs')` and `import('pkg')` against the script, as Node does; a plain `new AsyncFunction` resolves neither. Node 22 prints an `ExperimentalWarning` for that constant. The launcher drops that one warning in `process.emitWarning` and passes every other warning through. The launcher doesn't use a top-level `await`, so a script whose promise never settles ends the way a Node program does when its loop is empty, not with Node's exit code 13.

**Kernel.** `src/jsh.mjs` calls `runNode(ctx, { main })`. The `main` option replaces the script/eval entry. It runs once the runtime is set up, and receives `process`, `console`, `Buffer`, `fetch`, `createRequire`, the ESM loader's `importModule` and `rewriteDynamicImports`. A `.jsh` therefore gets exactly what a `node` script gets: real globals, `fetch` and `WebSocket` over `ctx`, the event loop, CJS and ESM, and Node's exit and uncaught-error handling. `runNode` tracks the body's promise as a handle. Two details:
- Compiling with `new AsyncFunction` adds two header lines. The runtime's stack formatting already removes those for `sourceURL` frames, so line numbers come out the file's own.
- `import()` in the body is rewritten to `importModule(specifier, script)`, so it resolves against the script, as on the host.

### `require` inside a `.jsh`

- `sliccy:<name>`: see below.
- Anything else goes to the engine's Node `require` from the script's location. `fs`, `path`, `node_modules`, `exports` conditions and builtins all behave as in Node, or as the shim does. A package that isn't installed fails with `MODULE_NOT_FOUND`; there is no esm.sh or `ipk` fallback.
- `require.resolve('sliccy:x')` returns `'sliccy:x'`.

### `sliccy:` modules

The resolution order is the same in both engines (`src/jsh/sliccy/index.mjs`):

1. Built in: `cli`, `color`, `exec`, `fmt`, `http`, `pool`, `skill`, `time`.
2. `@ai-ecoverse/sliccy-<name>`, then `sliccy-<name>`, resolved with Node's algorithm, first from the script's directory, then from slicc-jsh's own location, then from each of pnpm's global installs (`pnpm add -g`: `$PNPM_HOME`, else `/usr/local/share/pnpm`, `~/.local/share/pnpm` or `~/Library/pnpm`). The second step makes a global install next to a global `jsh` work.
3. Otherwise an error:
   - `agent`, `usb`, `serial`, `hid` and `computer` say `sliccy:<name> is only available inside SLICC`;
   - other names give v6's message plus `Install @ai-ecoverse/sliccy-<name> to provide it.`

**The `slicc` export condition:** the kernel shim resolves every `require` with the conditions `['slicc', 'require', 'node', 'default']` and every `import` with `['slicc', 'import', 'node', 'default']`. Host Node never sets `slicc`. A package, `sliccy-*` or any other, can therefore ship separate code for slicc-kernel.

| module | host `jsh` and kernel `jsh` | v6 |
|---|---|---|
| `cli`, `fmt`, `time`, `pool` | same code as v6 | |
| `color` | **on when stdout is a TTY**. `FORCE_COLOR` (anything but `''`, `0`, `false`) forces it on and `FORCE_COLOR=0` off; otherwise a non-empty `NO_COLOR` turns it off | on unless `NO_COLOR` |
| `exec` | `exec(cmd)` runs the engine's shell; `exec.spawn(argv)` uses no shell; `exec.start()` is v6's killable, buffered-stdin handle; results are `{ stdout, stderr, exitCode }`; a missing command gives 127 and `<cmd>: command not found` | just-bash |
| `http` | v6's `http.client`, over the engine's `fetch` | same, over the realm `fetch` |
| `skill` | `dir` is the script's directory; `root`, `refs` and `assets` are the skill folder's (the parent of a `scripts/` directory, as in v6); `config()` uses Node's `fs`; `token(id)` runs `jerk <id> get --reveal` and nothing else; a failure carries jerk's exit code as `err.exitCode` | same, over v6's `fs` and its shell, except that `token(id)` runs `oauth-token <id>` |
| `browser` | `@ai-ecoverse/sliccy-browser` over CDP ([slicc-cdp#40](https://github.com/ai-ecoverse/slicc-cdp/issues/40)) | RPC to SLICC's CDP owner |
| `agent`, `usb`, `serial`, `hid`, `computer` | error: SLICC only | yes |

### `sliccy:browser` over CDP ([slicc-cdp#40](https://github.com/ai-ecoverse/slicc-cdp/issues/40))

- **Package:** `@ai-ecoverse/sliccy-browser`, built on slicc-cdp's JS `CDPClient`/`connect`.
- **Connecting:** the same order `playwright-cli` uses:
  1. `SLICC_CDP_URL`;
  2. otherwise `http://127.0.0.1:9222/json/version`.

  `slicc launch` (slicc-cli) starts such a browser on a host. Inside the kernel, `SLICC_CDP_URL` is the kernel's 9222.
- **Calls:**
  - `findTab`/`ensureTab` → `Target.*`;
  - `eval`/`evalAsync` → `Runtime.evaluate`;
  - `cookie` → `Network.getCookies`;
  - `localStorage` and `fetch` → evaluated in the page, so the tab's cookies apply.
- **`websocket` sinks:**
  - `'log'`: works the same;
  - `'vfs'`: any absolute path the user can write;
  - `'webhook'` and `'scoop'`: SLICC only; they reject with `ENOTSUP`.
- **`require('playwright')`:** on a host, a real installed `playwright` is used as it is.

### Install and run

- `"bin": { "jsh": "dist/host/jsh.mjs" }`, so `npm i -g @ai-ecoverse/slicc-jsh` or `npx @ai-ecoverse/slicc-jsh script.jsh` works.
- **The `bin` inside the kernel.** A global `pnpm add -g @ai-ecoverse/slicc-jsh` in the kernel, as seven does it, links that `bin` into `$PNPM_HOME/bin`. That shadows the kernel's `jsh` command on `PATH`, so the host CLI ends up running under jsh's own `node` runtime, which lacks `vm` and the host-only builtins. To handle this, `dist/host/jsh.mjs` is a launcher with no static imports:
  - jsh's `node` runtime sets a non-enumerable `globalThis[Symbol.for('slicc-jsh.kernel')]` (`src/jsh/kernel.mjs`). If the launcher finds it, it hands its arguments to the kernel jsh, the same engine as the `jsh` command.
  - Otherwise it imports `./main.mjs`, the host CLI.
  - Nothing else sets that symbol, so a real host always gets the host CLI.

  `test/integration/pnpm-global.test.mjs` installs the packed tarball with the real wasi-pnpm and checks both the catalog `jsh` and the handoff. The case that goes through pnpm's bin shim needs `child_process` (the shim spawns `node`).
- `jsh [--version | --help] <script.jsh> [args…]`:
  - with no script it prints usage and exits 2;
  - an unknown option exits 9, as Node does;
  - a file that can't be read exits 1 with `jsh: cannot open <path>: <code>`.
- **`#!/usr/bin/env jsh` is the portable shebang.** The kernel also runs `#!/usr/bin/jsh` and, through binfmt, a `.jsh` file with no `#!` line. On a host, `#!/usr/bin/jsh` only works if someone links `jsh` there. A host has no binfmt, so a file without `#!` runs as `jsh file.jsh`.
- Windows runs `jsh file.jsh` through npm's `.cmd` shim.

### Detecting the host

`process.versions.jsh` is the slicc-jsh version in both engines. `globalThis.SLICC_VERSION` exists only inside SLICC.

## Parity tables

### Script semantics

| | v6 | kernel `jsh` | host `jsh` |
|---|---|---|---|
| async body, sloppy, top-level `await`/`return` | yes | yes | yes |
| static `import` | lowered to CJS, run strict | SyntaxError | SyntaxError (0 scripts use it) |
| `import()` | lowered | the runtime's ESM loader, relative to the script | Node's loader, relative to the script |
| `process.argv[0]` | `'node'` | `'jsh'` | `process.execPath`; use `argv.slice(2)` or `parseFlags()` |
| `require('fs')` | v6's promise-returning `fs` | Node's (the shim's) | Node's |
| `fs.*Sync` | snapshot taken at start, flushed at exit | live | live |
| stdin | buffered; `read()` returns all of it | Node stream; `fs.readFileSync(0, 'utf8')` | Node stream; `fs.readFileSync(0, 'utf8')` |
| exit | when the promise settles, after a short grace period | when the event loop is empty | when the event loop is empty |
| `process.exit()` | an exception user code can catch | exits at once | exits at once |
| uncaught error | stack to stderr, status 1 | Node's report, status 1, at once | same |
| `sliccy:color` | on unless `NO_COLOR` | on a TTY | on a TTY |
| `SLICC_VERSION` | set | unset | unset |

### Environment

| | inside SLICC | host `jsh` |
|---|---|---|
| file system | OPFS/VFS: `/workspace`, `/shared`, `/tmp` | the real one. `/workspace/…` paths don't exist (13 scripts); `skill.dir` is the portable way to find a skill's files |
| `PATH` commands for `exec` | kernel commands; `.jsh` scripts on `PATH` | host commands; `.jsh` scripts with `#!/usr/bin/env jsh` |
| `playwright-cli`, `curlwright` | built in | install `@ai-ecoverse/slicc-cdp` (native binaries) |
| `webhook`, `crontask`, `agent` | built in | not present |
| `jerk` (for `skill.token`) | seven: the `@ai-ecoverse/slicc-jerk` kernel command, which prints a vault placeholder; v6: `oauth-token` instead | install `@ai-ecoverse/slicc-jerk`; without it `skill.token` fails with `jerk: command not found` (127) |
| network | kernel transport / proxy | direct, no CORS |
| `process.env` | shell env plus the selected provider's API key | the host env |

## Testing

- **`npm run test:jsh`** (`scripts/jsh-golden.mjs`) runs `test/jsh/fixtures/<case>/main.jsh` two ways:
  - **The host `jsh` on Node 22.22.0 records the baseline**, as `npx node@22` does for `node`. It runs in a temporary copy of the fixture.
  - The kernel `jsh` on the Node entry must match stdout, stderr and status byte for byte.
  - `"stderr": "error-line"` compares only the `…Error: …` line, because stack frames name engine paths.
  - `"kernel": false` (with `kernelReason`) skips the kernel run. Today that applies only to `exec(cmd)`, since the test kernel installs no bash.
  - Every row of the script-semantics table has a case.
- **`test/integration/jsh.test.mjs`:**
  - kernel: `--version`/`--help`/bad option/missing file; a `.jsh` run through binfmt and through `#!/usr/bin/jsh`; the `slicc` condition winning in the kernel;
  - host: the `slicc` condition ignored; `./tool.jsh` through `#!/usr/bin/env jsh`.
- **CI:** besides those, CI installs the packed tarball globally and runs `jsh --version` and an executable `#!/usr/bin/env jsh` script.

## Milestones

- **H1 (shipped):** the `.jsh` layer, the host launcher and `bin`, the kernel `jsh` on the same layer, the `slicc` condition, and the parity harness.
- **H2 (shipped):** built-in `cli`, `color`, `fmt`, `time`, `pool`, `exec`, `http`, `skill`.
- **H3:** `@ai-ecoverse/sliccy-browser` in slicc-cdp ([slicc-cdp#40](https://github.com/ai-ecoverse/slicc-cdp/issues/40)).
- **H4:**
  - a CI job over ai-ecoverse/skills: each `.jsh` that uses no `browser` or device module runs with `--help` under both `jsh`s;
  - migrate the 47 scripts that use v6's `fs` and the 5 that rely on whole-buffer stdin.
- **Kernel follow-up:** bash in the test kernel, for `exec(cmd)`.

## Out of scope

- QuickJS (engine C), Deno and Bun.
- `sliccy:agent` and the device modules on a host.
- Remapping SLICC's paths (`/workspace` → a directory) or a `--root` option.
- `binfmt_misc` registration, and a REPL.
