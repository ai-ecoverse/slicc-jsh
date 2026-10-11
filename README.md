# @ai-ecoverse/slicc-jsh

A Node.js-compatible runtime for [slicc-kernel](https://github.com/ai-ecoverse/slicc-kernel): the `node` and `jsh` commands, built on the kernel's `abi: "js"` programs.

Design and milestones: [slicc-kernel#68](https://github.com/ai-ecoverse/slicc-kernel/issues/68). Running `jsh` outside SLICC (host Node, CDP): [docs/design/run-outside-slicc.md](docs/design/run-outside-slicc.md) (#20).

## Status

**0.2.0** — ships M2 net/http/https, M3 ESM, and host `jsh` (#22). Requires `slicc-kernel` ≥ 1.53.2 (Buffer `allocUnsafe` leak fix; 1.53.3 is the certified kernel). Published to npm `latest`.

**M1 shipped (0.1.0-8)** — Node-entry lockdown ([slicc-kernel#297](https://github.com/ai-ecoverse/slicc-kernel/issues/297)): CJS wrapper is Node's 5-arg form; `process` / `Buffer` / timers are real globals; vendor stream/string_decoder share jsh's Buffer class; StringDecoder accepts TypedArrays; timer stacks keep script URLs. Certified on hb2.

**M2 shipped:** `globalThis.fetch` / `WebSocket` from kernel ≥ 1.53.0 `OPEN_SLOTS` (`ctx.fetch` / `ctx.websocket`). `net` / `http` on `ctx.net` (loopback TCP); `https.createServer` waits on TLS, `https.request`/`get` use `ctx.fetch` with `redirect: 'manual'` (Node entry) and fall back to `'follow'` on browser transports that reject manual redirects (`ENOTSUP`). jsh `Buffer.allocUnsafe` / `allocUnsafeSlow` zero-fill and `poolSize` is `0`.

**M3 shipped:** ESM — `.mjs` / `"type":"module"`, static `import`/`export`, dynamic `import()`, `import.meta.url` / `import.meta.resolve`, and CJS↔ESM interop (`import` of CJS, `require` of ESM, `package.json` `"exports"` `import`/`require` conditions). The transform uses **acorn** (bundled) so multi-line imports/exports, strings/comments, and `$` identifiers parse correctly; imports are hoisted and export getters are registered before evaluation for cycles. Node-style detect-module for `-e` / ambiguous `.js` (dynamic `import()` alone stays CJS).

**Host jsh (#22):** package `bin` is `dist/host/jsh.mjs` — run `.jsh` on host Node 22+ with the same body scope and `sliccy:` modules as in the kernel.

**HTTP/HTTPS limits (M2):** request and response bodies are buffered whole (no streaming / SSE yet); bodies over 64 MiB are rejected (`413` on the server, `ERR_OUT_OF_RANGE` on the client). `https.request` options `cert` / `key` / `pfx` / `ca` throw `ERR_NOT_SUPPORTED` (no client certs / custom CA on `ctx.fetch`). `rejectUnauthorized: false` is accepted but ignored — TLS verification stays stricter than Node with that flag. Responses with no `Content-Length` and no chunked encoding wait for the peer's FIN (`socket.end` half-closes via `writer.close()` only). On the **browser** entry, `https.get` tries `redirect: 'manual'` and falls back to `'follow'` when the transport rejects it with `ENOTSUP` — so plain requests work, but a redirect may be followed instead of surfaced (`statusCode` / `Location`). The Node entry's `nodeTransport` supports manual redirects. Embedders with `traits.redirectHops` (kernel #315) can surface redirects in the browser.

**Still later:** `child_process` / `crypto` / `zlib` / `readline` / `tty` / `worker_threads` / TLS `https.createServer` throw `ERR_NOT_SUPPORTED` until their milestone.

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

Publish goes through `.github/workflows/publish.yml` (`workflow_dispatch` with `run` + `certified` sha). Stable versions (no `-` in the version) publish to `latest` and also advance the `next` dist-tag; prereleases publish to `next` only. Certification and publish are coordinator-owned; agents do not publish.
