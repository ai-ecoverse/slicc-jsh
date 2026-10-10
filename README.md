# @ai-ecoverse/slicc-jsh

A Node.js-compatible runtime for [slicc-kernel](https://github.com/ai-ecoverse/slicc-kernel): the `node` and `jsh` commands, built on the kernel's `abi: "js"` programs.

Design and milestones: [slicc-kernel#68](https://github.com/ai-ecoverse/slicc-kernel/issues/68). Running `jsh` outside SLICC (host Node, CDP): [docs/design/run-outside-slicc.md](docs/design/run-outside-slicc.md) (#20).

## Status

**M1 complete** — skeleton, `process`/`console`/`Buffer`/timers/CLI, CJS `require`, and core builtins (`fs`, `events`, `assert`, `util`, `os`, `url`, `querystring`, `string_decoder`, `stream`). First pre-release is `0.1.0-1` on the npm `next` tag. Servers/`net` are M2 (kernel `ctx.net` ≥ 1.43.1). Requires `slicc-kernel` ≥ 1.40.1 (`engines.slicc-kernel`) until then.

JS program entries are **esbuild-bundled** to single files (`dist/node.mjs`, `dist/jsh.mjs`) because the kernel loads `abi: "js"` modules via `data:` URLs (relative imports do not resolve).

## Commands

| Command | Module | Notes |
|---|---|---|
| `node` | `dist/node.mjs` | Node 22.x-compatible entry |
| `jsh` | `dist/jsh.mjs` | `.jsh` scripts; binfmt maps `.jsh` → `jsh` |

## `jsh` outside SLICC

The package's `bin` is the host `jsh` (`dist/host/jsh.mjs`), which runs `.jsh` scripts on the host's own Node 22+:

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

## Publish

Pre-releases (M1–M3) use the npm `next` tag via `.github/workflows/publish.yml` (`workflow_dispatch` with `run` + `certified` sha). Certification and publish are coordinator-owned; this package does not auto-publish from CI.
