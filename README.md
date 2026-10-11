# @ai-ecoverse/slicc-jsh

A Node.js-compatible runtime for [slicc-kernel](https://github.com/ai-ecoverse/slicc-kernel): the `node` and `jsh` commands, built on the kernel's `abi: "js"` programs.

Design and milestones: [slicc-kernel#68](https://github.com/ai-ecoverse/slicc-kernel/issues/68). Running `jsh` outside SLICC (host Node, CDP): [docs/design/run-outside-slicc.md](docs/design/run-outside-slicc.md) (#20).

## Status

**0.2.0** — ships M2 net/http/https, M3 ESM, and host `jsh` (#22). Requires `slicc-kernel` ≥ 1.53.2 (Buffer `allocUnsafe` leak fix; 1.53.3 is the certified kernel). Published to npm `latest`.

**M1 shipped (0.1.0-8)** — Node-entry lockdown ([slicc-kernel#297](https://github.com/ai-ecoverse/slicc-kernel/issues/297)): CJS wrapper is Node's 5-arg form; `process` / `Buffer` / timers are real globals; vendor stream/string_decoder share jsh's Buffer class; StringDecoder accepts TypedArrays; timer stacks keep script URLs. Certified on hb2.

**M2 shipped:** `globalThis.fetch` / `WebSocket` from kernel ≥ 1.53.0 `OPEN_SLOTS` (`ctx.fetch` / `ctx.websocket`). `net` / `http` on `ctx.net` (loopback TCP); `https.createServer` waits on TLS, `https.request`/`get` use `ctx.fetch` with `redirect: 'manual'` (Node entry) and fall back to `'follow'` on browser transports that reject manual redirects (`ENOTSUP`). jsh `Buffer.allocUnsafe` / `allocUnsafeSlow` zero-fill and `poolSize` is `0`.

**WebSocket / nodeTransport gap:** when `ctx.websocket` rejects, jsh maps that to an `error` Event (no `close`; `readyState` stays `CONNECTING`), matching Node 22 undici. On today's kernels the Node-entry `nodeTransport` / `fetchTransport` path often never rejects a failed connect (the transport ignores the socket `error` event before `open`), so a refused `ws://` can hang with no events until [slicc-kernel#366](https://github.com/ai-ecoverse/slicc-kernel/issues/366) lands. Do not probe with `ctx.net.connect` before open: that dials the **kernel** loopback, while `nodeTransport` WebSockets reach the **host**'s `127.0.0.1`.

**M3 shipped:** ESM — `.mjs` / `"type":"module"`, static `import`/`export`, dynamic `import()`, `import.meta.url` / `import.meta.resolve`, and CJS↔ESM interop (`import` of CJS, `require` of ESM, `package.json` `"exports"` `import`/`require` conditions). The transform uses **acorn** (bundled) so multi-line imports/exports, strings/comments, and `$` identifiers parse correctly; imports are hoisted and export getters are registered before evaluation for cycles. Node-style detect-module for `-e` / ambiguous `.js` (dynamic `import()` alone stays CJS).

**Host jsh (#22):** package `bin` is `dist/host/jsh.mjs` — run `.jsh` on host Node 22+ with the same body scope and `sliccy:` modules as in the kernel.

**HTTP/HTTPS limits (M2):** request and response bodies are buffered whole until `end()` when no `Content-Length` is set (then sent with a computed length); with `Content-Length`, body bytes stream as written. No chunked transfer encoding / SSE yet — multi-write responses still flush as one payload. Bodies over 64 MiB are rejected (`413` on the server, `ERR_OUT_OF_RANGE` on the client). `http.Agent` follows Node's `_http_agent.js` request path (`addRequest` → `createSocket` → `createConnection`) so **agent-base** / http(s)-proxy-agent subclasses work; `getName`, `destroy`, `keepSocketAlive`, `reuseSocket`, `removeSocket`, and `sockets` / `freeSockets` / `requests` are present. Keep-alive pooling is not implemented (`keepAlive` is accepted, `req.reusedSocket` is always `false`). `https.request` options `cert` / `key` / `pfx` / `ca` throw `ERR_NOT_SUPPORTED` (no client certs / custom CA on `ctx.fetch`). `rejectUnauthorized: false` is accepted but ignored — TLS verification stays stricter than Node with that flag. Responses with no `Content-Length` and no chunked encoding wait for the peer's FIN (`socket.end` half-closes via `writer.close()` only). On the **browser** entry, `https.get` tries `redirect: 'manual'` and falls back to `'follow'` when the transport rejects it with `ENOTSUP` — so plain requests work, but a redirect may be followed instead of surfaced (`statusCode` / `Location`). The Node entry's `nodeTransport` supports manual redirects. Embedders with `traits.redirectHops` (kernel #315) can surface redirects in the browser.

**npm ecosystem gaps:** packages that import `node:tty` (e.g. chalk's Node build) or need `crypto` (e.g. nanoid's main entry) fail with `ERR_NOT_SUPPORTED` until those modules ship. Prefer the browser/`default` export condition, or a fixture that pins it, when dogfooding. The `tls` module itself is unsupported (`ERR_NOT_SUPPORTED`) — so **http-proxy-agent** / **https-proxy-agent** (which import `tls` for CONNECT tunnels) cannot run yet even though `http.Agent` subclasses via agent-base work for plain `http`.

**Still later:** `child_process` / `crypto` / `zlib` / `readline` / `tty` / `tls` / `worker_threads` / TLS `https.createServer` throw `ERR_NOT_SUPPORTED` until their milestone.

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

## Release

Releases are cut by [semantic-release](https://semantic-release.gitbook.io/) on every push to `main` (`.github/workflows/release.yml`, the shared `node-release.yml` from slicc-shared-web), as in the sibling repos. It runs `npm run lint` and `npm test` (golden, `.jsh` parity, kernel integration), then derives the version from the commits since the last `v*` tag:
- a `feat:` commit gives a minor release (0.x stays 0.x until a breaking change);
- a `fix:` or `perf:` commit gives a patch release;
- other types (`chore:`, `docs:`, `ci:`, `test:`, `merge:`, …) release nothing.

It publishes to npm `latest` with trusted publishing (OIDC) and provenance, and creates a GitHub release. `version` in `package.json` stays `0.0.0`; semantic-release sets the real one when it publishes. npm has to trust `release.yml` for this package once: `npm run trust` (fledgling) sets that up, and `npm run trust:dry` shows what it would do.
