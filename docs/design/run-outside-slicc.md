# `jsh` outside SLICC

Status: **design, not approved.** Tracks [#20](https://github.com/ai-ecoverse/slicc-jsh/issues/20). Builds on the in-kernel design, [node-shim-on-js-programs.md](https://github.com/ai-ecoverse/slicc-kernel/blob/design/node-shim-on-js-programs/docs/design/node-shim-on-js-programs.md) ([slicc-kernel#68](https://github.com/ai-ecoverse/slicc-kernel/issues/68)).

Goal: a `.jsh` script runs on an ordinary macOS or Linux machine with `jsh script.jsh args…`, or as `./script.jsh` with a `#!/usr/bin/env jsh` line. On that machine:

- the JavaScript runs on the host's Node;
- `sliccy:browser` drives a real Chrome over CDP;
- tables say exactly what behaves the same as inside SLICC and what doesn't.

A script that uses only the portable surface then runs the same way in three places: SLICC v6, the kernel `jsh` (`abi: "js"`), and the host `jsh`.

## What a `.jsh` is today

In v6 (`packages/webapp/src/kernel/realm/`), a `.jsh` file is the **body of an async function**, run in sloppy mode:

- The function's parameters are `process, console, require, module, exports, fetch, __dirname, __filename`, in that order (`runUserCode` in `realm-module-system.ts`).
- Because it is a function body, top-level `await` and top-level `return` work. Static `import` declarations do not.
- `process.argv` is `['node', script, ...args]`, and it also has a non-enumerable `parseFlags()`.
- `require` resolves names in this order:
  1. `sliccy:<name>`;
  2. the shim's own built-in modules;
  3. refusals for native-addon packages;
  4. shimmed packages (`playwright`);
  5. `node_modules`.
- **`require('fs')` is not Node's `fs`.** Its methods return promises and take no callbacks, and it has a few calls of its own:
  - `readFile(p)` resolves to a string unless the encoding is `null` or `'buffer'`;
  - `stat(p)` resolves to `{ isDirectory, isFile, size }` with **boolean properties**, not methods;
  - `mkdir` always creates parent directories;
  - extra calls: `readFileBinary`, `writeFileBinary`, `readDir`, `exists`, `fetchToFile`;
  - `fs.promises === fs`;
  - only the `*Sync` methods behave like Node's (`realm-fs-bridge.ts`).
- Stdin is read in full before the script starts, so `process.stdin.read()` returns all of it at once.
- The script ends when its promise settles. In-flight work then gets a short, bounded grace period to finish, and timers still pending at that point are dropped.
- `globalThis.SLICC_VERSION` is set.

**The scripts in use today** (83 `.jsh` files: 82 in [ai-ecoverse/skills](https://github.com/ai-ecoverse/skills) at `01d62a5`, 1 in slicc's `packages/vfs-root` at `d407a914e`):

| use | scripts |
|---|---|
| `sliccy:cli` / `color` / `fmt` / `time` | 52 / 40 / 22 / 2 |
| `sliccy:exec` | 41 |
| `sliccy:browser` | 35 |
| `sliccy:skill` / `http` | 25 / 9 |
| `sliccy:usb` (no `agent`, `hid`, `serial`, `computer`, `pool`) | 1 |
| `process.argv.parseFlags()` | 56 |
| `require('fs')` | 53 |
| …and v6's promise-returning `fs` (`await fs.readFile(…)`, `fs.exists`, `readFileBinary`, …) | 47 |
| …reading `stat().isDirectory` as a property | 5 |
| `process.stdin` (5 of them rely on the whole-buffer `read()`) | 9 |
| a `/workspace/…` literal path | 13 |
| top-level `return` / dynamic `import()` / static `import` / `#!` | 2 / 4 / 0 / 0 |

47 of the 83 use no `browser` or device module. 41 of those also contain no `/workspace` literal, so they can run on a host without changes once the pure helpers and the `fs` compatibility layer are in place.

Through `exec(…)`, the scripts mostly call `playwright-cli` (38 calls), `webhook` (21), `crontask` (10) and `oauth-token` (3). Then come ordinary tools: `git`, `curl`, `cat`, `ls`, `rm`.

## Engine options

| | A. host Node (**proposed**) | B. slicc-kernel's Node entry | C. QuickJS |
|---|---|---|---|
| how it works | Run the `.jsh` wrapper on the host's real Node 22+ and its real builtins | Boot `@ai-ecoverse/slicc-kernel/node`, map a host directory as root, run the kernel `jsh` inside it | Run slicc-jsh's own runtime on QuickJS, with `ctx` implemented over qjs `std`/`os` |
| Node API fidelity | Exact: it *is* Node 22, the reference the shim is certified against | Whatever the shim offers | Whatever the shim offers, plus gaps in QuickJS itself (no Intl, slower) |
| host tools in `exec` | Real host commands | Only wasm commands installed in the kernel | Real host commands |
| match with SLICC | Differs where the shim differs from Node; the tables cover this | Highest | Same as B, minus the kernel |
| cost | Small: a launcher plus the shared `.jsh` layer | The README calls the Node entry "a testing entry, not a supported runtime"; slow start, no OPFS | A third engine to certify; a `ctx` port |
| install | `npm i -g`; `npx` works | Same, but heavy | Single binary (attractive later) |

**Proposal: A.** The point of running outside SLICC is to use the host's own files, commands and network, and real Node is the baseline the kernel shim is already measured against.

- **B** isn't a product, but it is the right tool for parity CI (see Testing).
- **C** remains possible later. The runtime only talks to `ctx`, so a QuickJS host means implementing `JsProgramContext`, with no rewrite. It stays separate from pi-codemode's QuickJS, as #68 asks.

## Design

### One `.jsh` layer, two engines

`.jsh` semantics live in one module, `src/jsh/`, which knows nothing about the engine:

- reading the file and stripping the `#!` line;
- the wrapper's parameter list;
- `parseFlags`;
- `sliccy:` resolution;
- the `fs` compatibility layer (below);
- exit rules.

It is used in two ways:

- **kernel `jsh`** = `src/jsh/` + `src/runtime/` (the Node shim on `ctx`);
- **host `jsh`** = `src/jsh/` + a thin adapter over real Node (`src/host/`).

Each engine passes in what the layer needs:

```js
// src/jsh/index.mjs (sketch)
export async function runJsh({ filename, source, argv, engine }) {}
// engine: {
//   createRequire(filename) -> require    // Node's algorithm (shim or real)
//   nodeFs                                // the engine's real `fs`
//   compile(body, params, filename)      -> async function   // keeps file:line in stacks
//   process, console, fetch, exit(code)
// }
```

Today `src/jsh.mjs` just calls `runNode`. The wrapper still has to be written for the kernel, so writing it once, behind this interface, costs nothing extra and makes the two engines behave alike by construction.

### Host package and install

- `package.json` gets `"bin": { "jsh": "dist/host/jsh.mjs" }`.
  - That file is bundled by esbuild for `platform: node` and starts with `#!/usr/bin/env node`.
  - `files` already ships `dist`.
  - `engines.node` stays `>=22`.
- Install with `npm i -g @ai-ecoverse/slicc-jsh`, or run one-off with `npx @ai-ecoverse/slicc-jsh script.jsh`.
- **`#!/usr/bin/env jsh` is the portable shebang.**
  - The kernel already resolves `#!/usr/bin/env name` and `#!/usr/bin/jsh`.
  - On a host, `#!/usr/bin/jsh` (as written in #20) only works if someone links `jsh` there.
- Host systems have no binfmt rule, so a `.jsh` without `#!` is run as `jsh file.jsh`. (Root users on Linux could register `binfmt_misc`; that's out of scope.)
- Windows runs `jsh file.jsh` through npm's `.cmd` shim. Shebangs don't apply there.

### Running the script on Node

1. Read the file as UTF-8. Replace a leading `#!…` line with an empty line so line numbers stay correct.
2. Compile it with `vm.runInThisContext`, wrapped as `(async function (process, console, require, module, exports, fetch, __dirname, __filename) {\n<body>\n})`.
   - Pass `filename` and `lineOffset: -1` so stack frames read `/path/x.jsh:LINE:COL`.
   - Pass `importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`. Then `import('./x.mjs')` and `import('pkg')` resolve against the script's location, as Node itself would. Tested on Node 22 and 24: a plain `new AsyncFunction` resolves neither.
   - Node 22 prints an `ExperimentalWarning` for that constant. The launcher filters that one message in `process.emitWarning` and lets every other warning through.
3. Pass in the arguments:
   - `process` is the real `process`, with `argv` set to `[process.execPath, script, ...args]` and `argv.parseFlags` defined on it as non-enumerable;
   - `console` and `fetch` are the real globals;
   - `module` is a real `Module` for `filename`, and `exports` is its `exports`;
   - `require` is `module.createRequire(filename)`, wrapped (next section).
4. Exit:
   - When the promise resolves, nothing special happens: the process exits when the event loop is empty, as in Node and as the kernel shim does.
   - When it rejects, the layer prints `err.stack` to stderr and calls `process.exit(1)`, the same as v6's `runUserCode`.
   - `process.exit(n)` exits immediately.

The script runs sloppy, not strict, as in v6.

### `require` inside a `.jsh`

The wrapper handles three kinds of name itself and passes everything else to Node:

- `sliccy:<name>` → see `sliccy:` modules.
- `fs`, `node:fs`, `fs/promises`, `node:fs/promises` → the **`.jsh` `fs` compatibility layer**.
- Anything else → Node's `require` from the script's location. `node_modules`, `exports` conditions and builtins all behave exactly as in Node. A package that isn't installed fails with `MODULE_NOT_FOUND`; there is no esm.sh or `ipk` fallback.

The compatibility layer applies only to the `require` given to `.jsh` files. Packages loaded from `node_modules` get Node's own `fs`.

### The `.jsh` `fs` compatibility layer (affects the kernel `jsh` too)

47 of 83 scripts depend on v6's `fs`, and code can't serve both v6 and Node, as one example shows: v6 expects `if (st.isDirectory)` (a property), Node `st.isDirectory()` (a method). The in-kernel design says a v6 script "runs unchanged when it uses only those globals and the pure `sliccy:` helpers", but under real `fs` these 47 would break in the kernel `jsh` as well. So the shared layer gives `.jsh` files Node's `fs`, with one rule added:

- **With a callback, or a `*Sync` name, it is Node.** Node's signatures, `Stats` and errors, unchanged.
- **Without a callback, it is v6.** It returns a promise with v6's results:
  - `readFile` without an encoding resolves to a UTF-8 string (`null` or `'buffer'` gives a `Buffer`);
  - `stat` resolves to an object with **boolean** `isDirectory`/`isFile`, plus `size` and `mtimeMs`;
  - `mkdir` is always recursive;
  - `rm`, `cp`, `rename`, `access`, `unlink`, `copyFile`, `appendFile`, `mkdtemp` behave as in v6;
  - plus v6's own calls: `readFileBinary`, `writeFileBinary`, `readDir`/`readdir` (names only), `exists`, `fetchToFile(url, path)`.
- `fs.promises` and `fs/promises` are the promise half of that rule, as `fs.promises === fs` was in v6.

A script that wants pure Node semantics uses `require('node:fs')` through `module.createRequire`. Equivalently, it `require`s a `.js` helper, which gets real `fs`. The layer can be removed once v6 is retired and the scripts are migrated (open question 1).

### `sliccy:` modules on the host

Resolution follows decision 3 of the in-kernel design: the module is either built into the shim or comes from a `sliccy-<name>` package. "The usual way" of finding that package is made exact here, and the kernel `jsh` must follow the same rule:

1. Names built into slicc-jsh.
2. `@ai-ecoverse/sliccy-<name>`, then `sliccy-<name>`, resolved with Node's algorithm, first from the script's directory, then from slicc-jsh's own install location. The second step makes a global install of `@ai-ecoverse/sliccy-browser` next to a global `jsh` work.
3. Otherwise an error. For a name that only exists inside SLICC, the error says so (`sliccy:usb is only available inside SLICC`). For any other name it gives v6's message, plus `npm i @ai-ecoverse/sliccy-<name>`.

If a package needs different code inside and outside the kernel, it can provide an `exports` condition named **`slicc`**. The kernel `jsh` resolves `sliccy-*` packages with `['slicc', 'require', 'node', 'default']`; the host never sets `slicc`.

| module | v6 | host `jsh` | same? |
|---|---|---|---|
| `cli`, `color`, `fmt`, `time`, `pool` | pure helpers | built in, same code as the kernel `jsh` | yes. `color` is on unless `NO_COLOR` is set, in all three; open question 4 |
| `exec` | runs the command in just-bash | `exec(cmd)` runs `bash -c cmd` if `bash` is on `PATH`, else `sh -c` (the kernel's `sh` is bash; Debian's is dash). `exec.spawn(argv)` runs argv with no shell. `exec.start` is built on `child_process.spawn` | same API; the **commands are the host's** (next table) |
| `http` | `http.client` over `fetch` | the same code over Node's `fetch` | yes. Host requests skip CORS and the kernel transport |
| `skill` | `dir`/`refs`/`assets`/`config()`; `token(id)` runs `oauth-token <id>` | same; `token` runs whatever `oauth-token` is on `PATH` | yes, except `token` fails unless the host provides `oauth-token` (open question 3) |
| `browser` | RPC to SLICC's CDP owner | `@ai-ecoverse/sliccy-browser` over CDP (below) | `findTab`/`ensureTab`/`eval`/`evalAsync`/`cookie`/`localStorage`/`fetch` are the same; `websocket` sinks differ |
| `agent` | runs the `agent` command | not available | no (later, perhaps via a slicc-cli link) |
| `usb`, `serial`, `hid`, `computer` | WebUSB/WebSerial/WebHID, desktop | not available | no |

The in-kernel note lists `http` and `skill` as modules the embedder provides. Both use nothing but `fetch`, `fs` and `exec`, so this proposes building them into slicc-jsh, the same as `cli` (open question 2).

### `sliccy:browser` over CDP

- **Package:** `@ai-ecoverse/sliccy-browser`, built on slicc-cdp's JS `CDPClient`/`connect`. The slicc-cdp repo would be its natural home.
- **Connecting:** the same order `playwright-cli` and `curlwright` use:
  1. `SLICC_CDP_URL`;
  2. otherwise `GET http://127.0.0.1:9222/json/version` and its `webSocketDebuggerUrl`.

  `slicc launch` (slicc-cli) starts such a browser in a separate profile and prints its URL. Inside the kernel, `SLICC_CDP_URL` is already set to the kernel's 9222. The same package can therefore serve both places if the kernel `jsh` provides a global `WebSocket` over `ctx.websocket`. If it doesn't, the `slicc` export condition covers the difference.
- **Mapping the calls:**
  - `findTab`/`ensureTab` → `Target.getTargets`/`createTarget`;
  - `eval`/`evalAsync` → `Runtime.evaluate` (with `awaitPromise` and `returnByValue`);
  - `cookie` → `Network.getCookies`;
  - `localStorage` and `fetch` → an evaluate call in the page, using v6's `buildBrowserFetchScript`, so cookies and origin rules are the tab's.
- **`browser.websocket`:** the router installed into the page is v6's (`ws-router-page.ts`), and it reports back through `Runtime.addBinding`.
  - Sink `'log'`: supported.
  - Sink `'vfs'`: supported, for any absolute path the user can write. v6's `/workspace/` prefix is a SLICC rule and doesn't apply on a host.
  - Sinks `'webhook'` and `'scoop'`: SLICC only; they reject with `ENOTSUP`.
- **`require('playwright')`:** v6's built-in replacement is SLICC only. On a host, a real `playwright`, if installed, is used as it is.

### Detecting the host

`process.versions.jsh` holds the slicc-jsh version in both engines. `globalThis.SLICC_VERSION` exists only inside SLICC. A script that needs to branch checks `typeof SLICC_VERSION`.

## Parity tables

### Script semantics

| | v6 | kernel `jsh` | host `jsh` |
|---|---|---|---|
| wrapper, sloppy, top-level `await`/`return` | yes | yes (shared layer) | yes (shared layer) |
| static `import` | lowered by the host | SyntaxError | SyntaxError (0 scripts use it) |
| `import()` | yes | `ctx.loadModule` | Node's loader, resolved against the script |
| `process.argv[0]` | `'node'` | the shim's `argv0` | `process.execPath`. Use `argv.slice(2)` or `parseFlags()` |
| `fs` (in `.jsh`) | v6 fs | compatibility layer | compatibility layer |
| `fs.*Sync` | snapshot taken at start, flushed at exit | live | live |
| `process.stdin.read()` | the whole buffer | Node stream | Node stream. **5 scripts break**; `fs.readFileSync(0, 'utf8')` works in all three |
| exit | when the promise settles, plus a short grace period | when the event loop is empty | when the event loop is empty. An open interval or socket keeps the script running |
| `process.exit()` | throws an exception user code can catch | exits | exits |
| uncaught error | stack to stderr, status 1 | same | same |
| stack frames | `<anonymous>` | `file:line` | `file:line` |
| `SLICC_VERSION` | set | set | unset |

### Environment

| | inside SLICC | host `jsh` |
|---|---|---|
| file system | OPFS/VFS: `/workspace`, `/shared`, `/tmp` | the real one. Paths like `/workspace/…` don't exist (13 scripts); `skill.dir` is the portable way to find a skill's files |
| `PATH` commands for `exec` | kernel commands; `.jsh` scripts on `PATH` | host commands; `.jsh` scripts run if they have `#!/usr/bin/env jsh` |
| `playwright-cli`, `curlwright` | built in | install `@ai-ecoverse/slicc-cdp` (native binaries) |
| `webhook`, `crontask`, `oauth-token`, `agent` | built in | not present |
| network | kernel transport / proxy | direct; no CORS |
| `process.env` | shell env plus the selected provider's API key | the host env as it is |
| stdin, TTY, signals | kernel fds, terminal, signals | the real ones |

## Testing

- **Shared fixtures:** `test/jsh/fixtures/<case>/` with a `.jsh` file plus the expected stdout, stderr and status, as the golden tests do now.
  - **The host `jsh` records the baseline**, as `npx node@22` does for `node`.
  - The kernel `jsh` must match it byte for byte on the Node entry (engine B). Rows the tables mark as different are pinned by their own fixtures, so any drift fails CI.
- **The tables are tested:** every row of the script-semantics table gets at least one fixture. That covers the compatibility layer's two halves, `parseFlags`, top-level `return`, `import()`, exit timing, and the error output.
- **Real scripts:** a CI job checks out ai-ecoverse/skills and runs each `.jsh` that uses no `browser` or device module with `--help` under the host `jsh`, comparing against the kernel `jsh`. Scripts that can't run on a host go on an allowlist that records why.
- **CDP:** `sliccy-browser` runs against headless Chrome (`--remote-debugging-port=0`) in CI: find/ensure a tab, eval, cookie, `fetch` with the page's cookies, and the `log` sink.
- **Packaging:** `npm pack`, install the tarball globally into a temporary prefix, then run `./x.jsh` through `#!/usr/bin/env jsh` and `npx`.

## Milestones

- **H1, layer and launcher:**
  - `src/jsh/` (wrapper, `#!` handling, `parseFlags`, exit rules, the `fs` compatibility layer);
  - `src/host/` and the `jsh` bin;
  - the kernel `jsh` switched over to the same layer;
  - shared fixtures.
- **H2, portable `sliccy:` modules:** `cli`, `color`, `fmt`, `time`, `pool`, `exec`, plus `http` and `skill` if approved; built into slicc-jsh and used by both engines.
- **H3, `sliccy:browser`:** `@ai-ecoverse/sliccy-browser` over slicc-cdp, with the CDP CI job.
- **H4, the real-script job:** checks against the skills corpus; migrate the 5 stdin scripts to `fs.readFileSync(0)`.

H1 and H2 depend on nothing new in the kernel. H3 depends on slicc-cdp's JS client, already exported on its `main`.

## Out of scope

- QuickJS (engine C), Deno and Bun. Bun or Deno might run the launcher, since it only uses `node:vm` and `node:module`, but neither is tested.
- `sliccy:agent` and the device modules on a host.
- Remapping SLICC's paths (`/workspace` → a directory) or a `--root` option.
- `binfmt_misc` registration, and a REPL (`jsh` with no file prints usage).

## Open questions for Lars

1. **`fs` compatibility layer:** keep v6's promise form for `.jsh` files in both engines (proposed), or migrate the 47 scripts and give `.jsh` plain Node `fs`?
2. **`http` and `skill`:** build them into slicc-jsh (proposed), or make them `sliccy-*` packages, as the in-kernel note has it?
3. **`skill.token` on a host:** only an `oauth-token` command on `PATH` (proposed), or also an environment fallback such as `SLICC_TOKEN_<PROVIDER>`, or a `slicc oauth-token` command in slicc-cli?
4. **Colour:** keep v6's rule everywhere (on unless `NO_COLOR`), or switch all three to "on when stdout is a TTY, `NO_COLOR`/`FORCE_COLOR` override"? The kernel can tell a TTY now, so this could change everywhere at once.
5. **Where `sliccy-browser` lives:** in slicc-cdp (proposed), or its own repo?
