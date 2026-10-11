# `jsh` in seven vs six vs Node

A comparison harness: every case in [`cases/`](cases) runs on four systems, and
what each one printed is recorded in [`results/`](results). The findings are in
[the gap report](../../docs/compare/seven-six-node.md); the mechanical summary
is [`results/SUMMARY.md`](results/SUMMARY.md).

| system | what runs | how |
|---|---|---|
| `six` | SLICC v6's JS realm, from a slicc checkout | [`six/driver.test.ts`](six/driver.test.ts) under slicc's own vitest `webapp` project: a real `AlmostBashShellHeadless` over a fake-indexeddb `VirtualFS`, the case under `/workspace/skills/jshc`, the shell command `main <args>` (so `.jsh` discovery → `jsh-executor` → `runInRealm` → `runJsRealm`). With no `Worker` under vitest the realm is the in-process one (`realm-inprocess.ts`), the same `runJsRealm` the DedicatedWorker runs |
| `seven` | the kernel `jsh` from this repo's `dist/` | slicc-kernel's Node entry, one kernel per case, with `@ai-ecoverse/wasm-bash` and `@ai-ecoverse/wasm-coreutils` installed so `exec(cmd)` has a shell; the case under `/os` |
| `jsh` | the host `jsh` (`dist/host/jsh.mjs`) | real Node 22.22.0 (`npx node@22.22.0`), in a temporary copy of the case |
| `node` | the case as a plain Node 22.22.0 program | the body as an ES module with `require`/`__filename`/`__dirname`/`module`/`exports` defined on line 1 (or `"node": "cjs"`, or a `node.mjs`/`node.cjs` in the case) |

`jsh` is the reference for `.jsh` semantics (it is the `.jsh` wrapper on real
Node); `node` is the tie-breaker for the Node API.

## Running

```sh
npm ci && npm run build
# a slicc checkout with `npm ci` done; a clean worktree of origin/main is best
git -C ~/Developer/ai-ecoverse/slicc worktree add --detach /tmp/slicc-six origin/main
(cd /tmp/slicc-six && npm ci)

scripts/mem-guard.sh node test/compare/run.mjs --systems jsh,node,seven
scripts/mem-guard.sh node test/compare/run.mjs --systems six --six-root /tmp/slicc-six
node test/compare/run.mjs --summary          # rewrite SUMMARY.md only
node test/compare/show.mjs fs-stat           # one case on every system
node test/compare/corpus.mjs                 # recount the corpus (corpus.json)
```

Name cases after the options to run only those. The seven pass takes about
3 minutes (one kernel at a time, well under the `mem-guard.sh` caps), the six
pass about 2 (one vitest process for all cases). The six driver is copied into
the checkout as `packages/webapp/tests/__jsh_compare__/` for the run and
removed afterwards. Don't point `--six-root` at a checkout with stale `.js`
files next to the `.ts` sources (vite prefers them).

## A case

`cases/<name>/case.json` plus `main.jsh` and any files it needs (fake packages
under `node_modules/` are committed). Fields: `area`, `description`, `corpus`
(feature keys from [`corpus.mjs`](corpus.mjs)), `entry`, `args`, `env`,
`stdin`, `node` and `skip`; see the header of [`run.mjs`](run.mjs). Most cases
start with one line of probe helpers (`show(label, fn)`, `showA` for async)
that print a value or `THROW <name> <code>: <message>`.

Each system gets `COMPARE_HTTP`, the base URL of a local HTTP and WebSocket
server the runner starts (`/json`, `/text`, `/missing`, `/redirect`, `/slow`,
`/bytes`, `/echo`, `/mod.mjs`). Results are normalised: the case directory is
`$CASE`, Node's path `$NODE`, the server `$HTTP`, this repo `$REPO`, and stack
frames outside the case collapse to `at <internal>`. A stdout over 64 KB is
stored as its digest.

## What the six column can't show

The in-process realm runs on the test process's own globals, so a few rows are
measured on Node rather than on a browser worker. The gap report marks them:

- unhandled rejections: v6 watches `unhandledrejection` on the worker's global
  scope, which Node's `globalThis` doesn't fire (`realm-unhandled-rejections.ts`);
- `child_process.*Sync`: needs the Service Worker's sync bridge, absent here;
- a native `import()` the realm doesn't rewrite (inside `new Function`) hits
  Node's loader instead of the browser's;
- `globalThis.process` is the test runner's, where a worker gets the shim;
- the global object's other names (`setImmediate`, `BroadcastChannel`, …) are
  Node's.
