# @ai-ecoverse/slicc-jsh

A Node.js-compatible runtime for [slicc-kernel](https://github.com/ai-ecoverse/slicc-kernel): the `node` and `jsh` commands, built on the kernel's `abi: "js"` programs.

Design and milestones: [slicc-kernel#68](https://github.com/ai-ecoverse/slicc-kernel/issues/68).

## Status

**M1 shipped (0.1.0-8)** — Node-entry lockdown ([slicc-kernel#297](https://github.com/ai-ecoverse/slicc-kernel/issues/297)): CJS wrapper is Node's 5-arg form; `process` / `Buffer` / timers are real globals; vendor stream/string_decoder share jsh's Buffer class; StringDecoder accepts TypedArrays; timer stacks keep script URLs. Certified on hb2.

**M2 shipped (on main):** `globalThis.fetch` / `WebSocket` from kernel ≥ 1.53.0 `OPEN_SLOTS` (`ctx.fetch` / `ctx.websocket`). `net` / `http` on `ctx.net` (loopback TCP); `https.createServer` waits on TLS, `https.request`/`get` use `ctx.fetch` with `redirect: 'manual'` (Node entry) and fall back to `'follow'` on browser transports that reject manual redirects (`ENOTSUP`). jsh `Buffer.allocUnsafe` / `allocUnsafeSlow` zero-fill and `poolSize` is `0`. Requires `slicc-kernel` ≥ 1.53.0.

**M3 (in progress):** ESM — `.mjs` / `"type":"module"`, static `import`/`export`, dynamic `import()`, `import.meta.url` / `import.meta.resolve`, and CJS↔ESM interop (`import` of CJS, `require` of ESM, `package.json` `"exports"` `import`/`require` conditions). The transform uses **acorn** (bundled) so multi-line imports/exports, strings/comments, and `$` identifiers parse correctly; imports are hoisted and export getters are registered before evaluation for cycles. Publish of the next version waits on hb2 cert of a kernel with the hostfs fix (1.54.0 or newer when certified).

**HTTP/HTTPS limits (M2):** request and response bodies are buffered whole (no streaming / SSE yet); bodies over 64 MiB are rejected (`413` on the server, `ERR_OUT_OF_RANGE` on the client). `https.request` options `cert` / `key` / `pfx` / `ca` throw `ERR_NOT_SUPPORTED` (no client certs / custom CA on `ctx.fetch`). `rejectUnauthorized: false` is accepted but ignored — TLS verification stays stricter than Node with that flag. Responses with no `Content-Length` and no chunked encoding wait for the peer's FIN (`socket.end` half-closes via `writer.close()` only). On the **browser** entry, `https.get` tries `redirect: 'manual'` and falls back to `'follow'` when the transport rejects it with `ENOTSUP` — so plain requests work, but a redirect may be followed instead of surfaced (`statusCode` / `Location`). The Node entry's `nodeTransport` supports manual redirects. Embedders with `traits.redirectHops` (kernel #315) can surface redirects in the browser.

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
