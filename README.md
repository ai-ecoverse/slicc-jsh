# @ai-ecoverse/slicc-jsh

A Node.js-compatible runtime for [slicc-kernel](https://github.com/ai-ecoverse/slicc-kernel): the `node` and `jsh` commands, built on the kernel's `abi: "js"` programs.

Design and milestones: [slicc-kernel#68](https://github.com/ai-ecoverse/slicc-kernel/issues/68).

## Status

**M1 shipped (0.1.0-8)** — Node-entry lockdown ([slicc-kernel#297](https://github.com/ai-ecoverse/slicc-kernel/issues/297)): CJS wrapper is Node's 5-arg form; `process` / `Buffer` / timers are real globals; vendor stream/string_decoder share jsh's Buffer class; StringDecoder accepts TypedArrays; timer stacks keep script URLs. Certified on hb2.

**M2 (in progress):** `globalThis.fetch` / `WebSocket` from kernel ≥ 1.53.0 `OPEN_SLOTS` (`ctx.fetch` / `ctx.websocket`). `net` / `http` on `ctx.net` (loopback TCP); `https.createServer` waits on TLS, `https.request`/`get` use `ctx.fetch` with `redirect: 'manual'` (same as Node — redirects are not followed). Next: ESM. jsh `Buffer.allocUnsafe` / `allocUnsafeSlow` zero-fill and `poolSize` is `0`. Requires `slicc-kernel` ≥ 1.53.0. Publish of the next version waits on the kernel release that carries the Node-entry Buffer fix (#324).

**HTTP/HTTPS limits (M2):** request and response bodies are buffered whole (no streaming / SSE yet); bodies over 64 MiB are rejected (`413` on the server, `ERR_OUT_OF_RANGE` on the client). `https.request` options `cert` / `key` / `pfx` / `ca` throw `ERR_NOT_SUPPORTED` (no client certs / custom CA on `ctx.fetch`). `rejectUnauthorized: false` is accepted but ignored — TLS verification stays stricter than Node with that flag. Responses with no `Content-Length` and no chunked encoding wait for the peer's FIN (`'end'`) — no idle guess; if `ctx.net` never delivers FIN (see `scripts/repro-ctx-net-fin.mjs` on the Node entry), that close-framed response hangs until the socket errors. On the **browser** entry, the page `fetchTransport` has `manualRedirects: false`, so `redirect: 'manual'` is rejected with `ENOTSUP` (not an opaque redirect); `https.get` cannot observe `statusCode` / `Location` there unless the embedder supplies redirect hops (`traits.redirectHops`, kernel #315). The Node entry's `nodeTransport` does support manual redirects.

**Still later:** `child_process` / `crypto` / `zlib` / `readline` / `tty` / `worker_threads` / TLS `https.createServer` throw `ERR_NOT_SUPPORTED` until their milestone.

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
