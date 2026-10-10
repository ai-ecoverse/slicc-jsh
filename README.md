# @ai-ecoverse/slicc-jsh

A Node.js-compatible runtime for [slicc-kernel](https://github.com/ai-ecoverse/slicc-kernel): the `node` and `jsh` commands, built on the kernel's `abi: "js"` programs.

Design and milestones: [slicc-kernel#68](https://github.com/ai-ecoverse/slicc-kernel/issues/68).

## Status

**M1 candidate (0.1.0-3)** — hardening after the `0.1.0-2` cert FAIL. Cert harness: 80 + 50 cases (hb2), kernel loaded from a plain dist path, minimal stderr masking.

**Not in M1 (by design):** `child_process` / `net` / `http` / `crypto` / `zlib` / `readline` / `tty` / `worker_threads` throw `ERR_NOT_SUPPORTED`. ESM (`.mjs` / `"type":"module"`) is M2. Global `fetch` / `WebSocket` are present but throw `ERR_NOT_SUPPORTED` until M2 (`ctx.fetch` / `ctx.websocket` / http). Requires `slicc-kernel` ≥ 1.40.1 (`engines.slicc-kernel`) until servers land.

JS program entries are **esbuild-bundled** to single files (`dist/node.mjs`, `dist/jsh.mjs`) because the kernel loads `abi: "js"` modules via `data:` URLs (relative imports do not resolve).

## Commands

| Command | Module | Notes |
|---|---|---|
| `node` | `dist/node.mjs` | Node 22.x-compatible entry |
| `jsh` | `dist/jsh.mjs` | `.jsh` scripts; binfmt maps `.jsh` → `jsh` |

## Develop

```bash
npm ci
npm run build
npm run lint
npm run test:golden          # host Node 22 baselines (npx node@22)
npm run test:integration     # slicc-kernel Node entry, memory root
```

Golden fixtures live under `test/golden/fixtures/` and are **not** published (`files` allowlists `dist` only). Record baselines with Node 22:

```bash
npm run golden:record
```

## Publish

Pre-releases (M1–M3) use the npm `next` tag via `.github/workflows/publish.yml` (`workflow_dispatch` with `run` + `certified` sha). Certification and publish are coordinator-owned; this package does not auto-publish from CI.
