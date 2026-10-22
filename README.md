# @ai-ecoverse/slicc-jsh

slicc-jsh gives [slicc-kernel](https://github.com/ai-ecoverse/slicc-kernel) a Node.js 22-compatible `node` command, and a `jsh` command that runs `.jsh` scripts. It also ships a host `jsh` CLI that runs the same `.jsh` scripts on a normal machine, on the machine's own Node 22.

- [Install](#install)
- [Quick start](#quick-start)
- [Node compatibility](#node-compatibility)
- [Kernel requirements](#kernel-requirements)
- [Develop](#develop)
- [CI and releases](#ci-and-releases)

## Install

### On your machine: `curl … | sh`

On macOS or Linux (x64 or arm64), without npm:

```sh
curl -fsSL https://raw.githubusercontent.com/ai-ecoverse/slicc-jsh/main/install.sh | sh
```

What [`install.sh`](install.sh) does:

- **Node.** It uses the `node` on `PATH` if that is Node 22 or later. If not, it asks before it downloads the latest Node 22 LTS from nodejs.org into `~/.jsh/node`, and checks it against nodejs.org's `SHASUMS256.txt`. That Node is for jsh only: no sudo, no package manager. No flag skips the question. With no terminal (CI), it stops and says how to install Node 22 (nodejs.org, Homebrew, fnm or nvm). On musl (Alpine) it asks you to install Node 22 with your package manager.
- **jsh.** It gets the latest version (or the one you ask for) from the npm registry, checks the tarball against the registry's sha512 `integrity`, and unpacks it to `~/.jsh/lib/node_modules/@ai-ecoverse/slicc-jsh`. The new version is unpacked next to the old one and only moved in once it runs, so a failed upgrade keeps the old one.
- **The `jsh` command.** It writes `~/.local/bin/jsh`, a small `sh` script that runs that Node on the installed jsh. It is a file, not an alias, so `#!/usr/bin/env jsh`, cron and non-interactive shells work. It won't overwrite a `jsh` it didn't write. If `~/.local/bin` isn't on `PATH`, it asks before it adds one line to your shell's rc file (`.zshrc`, `.bashrc` or `.bash_profile`, fish's `config.fish`, else `.profile`). Without a terminal it prints the line instead.
- It ends with `jsh --version`.

Run it again to upgrade jsh, and to update its private Node to the latest 22.

| Variable | Default | What it sets |
|---|---|---|
| `JSH_HOME` | `~/.jsh` | where jsh and its private Node go |
| `JSH_BIN_DIR` | `~/.local/bin` | where the `jsh` command goes |
| `JSH_VERSION` | latest | the version to install (or `--version x.y.z`) |
| `JSH_INTEGRITY` | none | the sha512 the tarball must have (or `--integrity sha512-…`) |

```sh
# a given version
curl -fsSL https://raw.githubusercontent.com/ai-ecoverse/slicc-jsh/main/install.sh | sh -s -- --version 0.16.1
# remove ~/.jsh and the jsh command
curl -fsSL https://raw.githubusercontent.com/ai-ecoverse/slicc-jsh/main/install.sh | sh -s -- --uninstall
```

`--uninstall` uses the same `JSH_HOME` and `JSH_BIN_DIR`, if you set them. It doesn't edit rc files; it tells you which line to remove.

**Trust.** The script trusts the npm registry and nodejs.org over HTTPS. By default the hashes it checks come from the same place as the files, and it pins no hash of its own. `--version` pins a version, not a hash.

To pin the bytes, give `--integrity` (or `JSH_INTEGRITY`) with the version. Then the registry's `dist.integrity` and the downloaded tarball must both equal that value, or the installer stops and prints the expected and actual values:

```sh
# the sha512 to pin, from a source you trust
npm view @ai-ecoverse/slicc-jsh@0.37.1 dist.integrity
curl -fsSL https://raw.githubusercontent.com/ai-ecoverse/slicc-jsh/main/install.sh |
  sh -s -- --version 0.37.1 --integrity sha512-…
```

Only a `sha512-` value is accepted; other algorithms and malformed values are refused before anything is downloaded. The pin covers the jsh tarball, not the installer script or the private Node.

**Windows** isn't covered yet: [ai-ecoverse/slicc-jsh#127](https://github.com/ai-ecoverse/slicc-jsh/issues/127). With npm, `jsh file.jsh` runs through npm's `.cmd` shim.

### With npm

The package's `bin` is the host `jsh` (`dist/host/jsh.mjs`). It runs `.jsh` scripts on the host's own Node 22 or later.

```sh
npm i -g @ai-ecoverse/slicc-jsh
jsh script.jsh args…
npx @ai-ecoverse/slicc-jsh script.jsh
```

### Inside slicc-kernel

Install the package in the kernel with pnpm:

```sh
pnpm add -g @ai-ecoverse/slicc-jsh
```

The kernel reads the `slicc` field of the package's `package.json` and registers two `abi: "js"` programs:

| Command | Module | What it is |
|---|---|---|
| `node` | `dist/node.mjs` | the Node 22.x-compatible runtime |
| `jsh` | `dist/jsh.mjs` | runs `.jsh` scripts; `slicc.binfmt` maps `.jsh` files to `jsh` |

`pnpm add -g` also links the npm `bin` (the host CLI) into `$PNPM_HOME/bin`, ahead of the kernel's `jsh` on `PATH`. That's fine: inside the kernel the host CLI hands its arguments to the kernel `jsh`.

The package needs `slicc-kernel` 1.53.2 or later (`engines`). Some features need a newer kernel: see [Kernel requirements](#kernel-requirements).

## Quick start

A `.jsh` file is the body of an async function. `process`, `console`, `require`, `module`, `exports`, `fetch`, `__dirname` and `__filename` are in scope, and top-level `await` and `return` work. It is the same in the kernel and on the host.

```js
#!/usr/bin/env jsh
// hello.jsh
const fs = require('fs');                     // Node's fs
const { col } = require('sliccy:fmt');
const flags = process.argv.parseFlags();      // { positional, flags, subcommand, passthrough }
const res = await fetch('https://example.com/');
console.log(col('status', 8), res.status, flags.positional);
```

```sh
jsh hello.jsh a b             # or: chmod +x hello.jsh && ./hello.jsh a b
node -e 'console.log(process.version)'
node script.mjs
```

- `#!/usr/bin/env jsh` is the portable shebang. The kernel also runs `#!/usr/bin/jsh`, and through binfmt a `.jsh` file with no `#!` line. A host has no binfmt: run such a file as `jsh file.jsh`.
- A static `import` in a `.jsh` is a `SyntaxError`; use `await import()`.
- `jsh [--version | --help] <script.jsh> [args…]`. With no script it prints usage and exits 2; an unknown option exits 9; a file it can't read exits 1.
- `process.versions.jsh` is the slicc-jsh version in both `jsh`s. `globalThis.SLICC_VERSION` exists only inside SLICC.

### `sliccy:` modules

| Name | What it is |
|---|---|
| `cli`, `fmt`, `time`, `pool` | the same code as SLICC v6 |
| `color` | on when stdout is a terminal; `FORCE_COLOR` and `NO_COLOR` change that |
| `exec` | `exec(cmd)` through the shell, `exec.spawn(argv)` without one; results are `{ stdout, stderr, exitCode }` |
| `http` | v6's `http.client`, over `fetch` |
| `skill` | `dir` is the script's directory, and `config()` reads and writes `.config` there; `root` is the skill folder (the parent of a `scripts/` directory), with `refs` and `assets` in it; `token(id, params)` runs [`jerk`](https://github.com/ai-ecoverse/slicc-jerk) `<id> get --reveal`, with `-p key=value` for each entry of the optional `params` bag (`skill.token('aem', { org, site })`), and returns the token, or throws jerk's message with `err.exitCode` (3: sign in with `jerk <id> create`) |

Any other `sliccy:<name>` is the package `@ai-ecoverse/sliccy-<name>`, else `sliccy-<name>`. jsh looks for it in this order:

1. next to the script (Node's `node_modules` lookup);
2. next to slicc-jsh itself (so `npm i -g --prefix ~/.jsh sliccy-<name>` works with the `curl | sh` install);
3. in pnpm's global installs (`pnpm add -g`): under `$PNPM_HOME`, else pnpm's default home (`/usr/local/share/pnpm` in the kernel, `~/.local/share/pnpm` on Linux, `~/Library/pnpm` on macOS).

`agent`, `usb`, `serial`, `hid` and `computer` exist only inside SLICC; jsh says so. `sliccy:browser` is [`@ai-ecoverse/sliccy-browser`](https://github.com/ai-ecoverse/slicc-cdp/issues/40) from slicc-cdp, over CDP (`pnpm add -g @ai-ecoverse/sliccy-browser`); in the kernel it drives the browser behind `SLICC_CDP_URL`.

Packages can ship separate code for the kernel: there, `require` and `import` resolve with the `slicc` export condition first. Host Node never sets it.

More: [docs/design/run-outside-slicc.md](docs/design/run-outside-slicc.md) (how a `.jsh` runs, the [parity tables](docs/design/run-outside-slicc.md#parity-tables) between SLICC v6, the kernel `jsh` and the host `jsh`).

## Node compatibility

The target is Node v22.22.0. Much of the runtime is Node's own `lib/` code, carried in [`src/node-lib`](src/node-lib/README.md). Outputs are checked byte for byte against real Node 22.22.0 (see [Develop](#develop)).

This table is the summary. Details, quirks and the libraries behind each module are in **[docs/compatibility.md](docs/compatibility.md)**. How `.jsh` scripts behave in the kernel, in SLICC v6 and in Node, case by case, is in the comparison report [docs/compare/seven-six-node.md](docs/compare/seven-six-node.md).

| Area | Supported | Differs | Not available |
|---|---|---|---|
| [`node` command](docs/compatibility.md#the-node-command) | `-e`, `-p`, `-i`, `-`, `-c`/`--check`, `-r`, `--import`, `--input-type`, `NODE_OPTIONS`, warning flags, `--enable-source-maps`, `--report-*`, `--stack-trace-limit` | `--max-old-space-size` and `--trace-uncaught` are accepted and do nothing | inspector and debugger flags, `--watch`, TypeScript |
| [Modules, ESM](docs/compatibility.md#modules-and-esm) | CommonJS with Node's resolution, ESM, `import()`, `import.meta`, CJS↔ESM interop, `require(esm)`, `exports`/`imports`, source maps, `--preserve-symlinks` | in the kernel, the `slicc` condition comes first | `module.register`/`registerHooks`, native addons, `.ts` files |
| [`process`](docs/compatibility.md#process-and-the-end-of-a-program) | exit codes and `'exit'`, signals, `kill`, `chdir`, `env`, `report`, `execve`, `emitWarning`, `loadEnvFile` | `exit()` ends at once from kernel 1.65; `kill(self)` from 1.72; `setuid` & co. from 1.81 | — |
| [stdio, `tty`](docs/compatibility.md#stdio-tty-and-signals) | Node streams, `isTTY`, `setRawMode`, `columns`/`rows`, `'resize'` | signal handlers and raw mode take effect a moment after the call; `isatty` knows fds 0–2 only | — |
| [`fs`](docs/compatibility.md#fs) | sync, callback, promise and stream forms, `file:` URLs, symlinks, `cp`, `statfs`, `watchFile` (polling `stat`, as Node), `watch` and `promises.watch` (kernel 1.125, as Node reports on Linux), `/dev` (kernel 1.69) | `chmod` and new files' modes from kernel 1.86, before that they change nothing; `chown`, `utimes` change nothing; `mkdir` exclusive from 1.86; `linkSync` only on `tmpfs`; `statfs` is the browser's storage estimate; a watched path renamed away ends its watch | `glob`, `openAsBlob`, `readv`/`writev` |
| [`child_process`](docs/compatibility.md#child_process) | `spawn`, `exec`, `execFile`; `spawnSync`, `execSync`, `execFileSync` (kernel 1.65) | fd stdio order from 1.70; `detached` from 1.74; `argv0` from 1.76; `.pid` at return from 1.87 | `fork`; stdio slots past fd 2 |
| [`net`, `http`, `https`](docs/compatibility.md#net-http-and-https) | TCP and HTTP/1.1 servers and clients on the kernel's loopback, and to other hosts where the kernel's uplink routes them; streamed responses; keep-alive; `'upgrade'`; `http.Agent` subclasses; `https` client | without a route, `http` goes through `fetch`, as `https` always does: no raw socket, Agent pooling, upgrade/`CONNECT`, 100-continue or trailers; normalized headers; buffered upload; redirects followed in the browser | TLS servers (`tls.Server#listen`), TLS other than HTTP/1.1 and WebSocket to a host the kernel's uplink doesn't route ([`tls`](docs/compatibility.md#tls): from kernel 1.116 through its transport; from 1.124 any protocol, a custom `ca` and STARTTLS to an uplink host, from 1.124.13 client certificates there too), HTTP/2 sessions ([`http2`](docs/compatibility.md#http2) loads, but `connect` and `listen` throw), `https.createServer`, `pfx` client certificates, Unix sockets |
| [`dns`](docs/compatibility.md#dns) | `lookup` (callback and promises), `resolve4`/`resolve6` through the kernel's resolver (`/etc/hosts`, its names, the uplink) from kernel 1.113, `lookupService`, Node's surface and errors | before kernel 1.113, only IP literals and the kernel's own names (`localhost`, `*.localhost`, its hostname): another name is `getaddrinfo ENOTFOUND` | other queries (`resolveMx`, `resolveSrv`, …): no nameserver |
| [`fetch`, `WebSocket`](docs/compatibility.md#fetch-and-websocket) | the globals, over the kernel's network | loopback URLs reach servers of this kernel: `fetch` over jsh's own HTTP client (the kernel's loopback `ctx.fetch` still differs from undici), `WebSocket` over the kernel's `ctx.websocket` from kernel 1.106.3 and jsh's own RFC 6455 client before that ([slicc-kernel#822](https://github.com/ai-ecoverse/slicc-kernel/issues/822)); refused connects as Node's from kernel 1.59.1 | — |
| [`crypto`](docs/compatibility.md#crypto) | hashes, HMAC, PBKDF2, HKDF, scrypt, AES and 3DES ciphers, secret keys, random, `webcrypto` | — | asymmetric keys, sign/verify, DH/ECDH, RSA, primes, X509 |
| [`zlib`](docs/compatibility.md#zlib) | deflate, inflate, gzip, raw, Brotli and Zstd decompression, `crc32`, streams and callbacks | — | Brotli and Zstd compression |
| [Streams, `Buffer`](docs/compatibility.md#streams-and-buffer) | `stream` (readable-stream 4), `stream/promises`, `stream/web`, `stream/consumers`, `Buffer`, `string_decoder` | `Buffer.allocUnsafe` zero-fills; `poolSize` is 0 | — |
| [`events`](docs/compatibility.md#events) | Node's own `lib/events.js`, for every emitter | `getEventListeners` doesn't take platform `EventTarget`s | — |
| [`readline`, REPL](docs/compatibility.md#readline-and-the-repl) | `readline`, `readline/promises`, Node's REPL, `repl.start()` | no previews as you type, no `^C` out of a running loop | — |
| [`util`, `console`, `os`, `path`, `url`](docs/compatibility.md#util-console-os-path-url-querystring-punycode) | Node's own lib files | `os` reports the kernel (loopback only, Linux constants) | — |
| [`vm`](docs/compatibility.md#vm) | scripts, contexts, `compileFunction`, dynamic `import()` | one realm: a context isn't a separate realm | `vm.Module`, `timeout`, `breakOnSigint`, `measureMemory` |
| [`async_hooks`, `domain`, `perf_hooks`, `v8`, …](docs/compatibility.md#async_hooks-domain-perf_hooks-v8-and-diagnostics) | `AsyncResource`, `AsyncLocalStorage`, `domain`, `diagnostics_channel`, `perf_hooks`, `v8` statistics | `createHook` hooks never run; domains don't follow promises; an `AsyncLocalStorage` store doesn't survive a native `await` (it's then missing, never another run's) | `v8.serialize`, heap snapshots |
| [Workers and the rest](docs/compatibility.md#modules-that-are-not-available) | `worker_threads` as the main thread, `BroadcastChannel` within a program (the global from kernel 1.92) | `new Worker` throws `ERR_NOT_SUPPORTED` | `cluster.fork`, `dgram`, `inspector.open` (no inspector), `test`, `sqlite`, `wasi` |

## Kernel requirements

The package needs `slicc-kernel` 1.146.2 or later: `engines.slicc-kernel` is the kernel CI tests, the `@ai-ecoverse/slicc-kernel` devDependency, and the two move together. jsh has no fallbacks for older kernels.

## Develop

```sh
npm ci
npm run build                # esbuild: dist/node.mjs, dist/jsh.mjs, dist/vendor/, dist/host/
npm run lint
```

The kernel loads `abi: "js"` modules from `data:` URLs, where relative imports don't resolve. So each program entry is bundled into one file.

| Command | What it covers |
|---|---|
| `npm test` | every file in `test/integration/`, what CI runs; `pretest` installs Chrome for Testing at `config.chrome` |
| `npm run test:golden` | each fixture in `test/golden/fixtures/` on host Node 22.22.0 and on `node` in slicc-kernel's Node entry: stdout, stderr and status, byte for byte (`golden-1` to `golden-4.test.mjs` run a quarter each) |
| `npm run test:jsh` | each `.jsh` case in `test/jsh/fixtures/` on the host `jsh` (the baseline) and on the kernel `jsh` (`jsh-parity.test.mjs`) |

The files in `test/integration/` are `node:test` suites on slicc-kernel's Node entry: child processes, `pnpm add -g`, ESM, HTTP, WebSocket, exit and signals, PostgreSQL over TLS (`tls-sealed-postgres`, through `embedded-postgres`). A few wrap a harness of their own:

- `differential.test.mjs`: the cases in `test/integration/cert/`, host Node 22 against the shim, with the kernel loaded from a plain `dist` path;
- `node-parallel.test.mjs`: a slice of Node v22.22.0's own `test/parallel` with Node's `test/common`; every file passes but the known gaps it lists;
- `browser-*.test.mjs`: the kernel in a Chromium tab, with slicc-jsh and `@ai-ecoverse/sliccy-browser` installed by `pnpm add -g`; `sliccy:browser` and its skills corpus, compared with the host `jsh`. `JSH_TARBALL=/path/to.tgz` and `SLICCY_BROWSER` (a version or a local tarball) pin a release. Chrome runs headless unless `CI` is set; `SLICC_HEADLESS=1` or `0` overrides;
- `install.test.mjs`: `install.sh` in throwaway `HOME`s, against the published package (needs curl, Node 22+, python3 and perl);
- `package.test.mjs`: the tarball `npm pack` makes from a copy of the checkout: `NOTICE`, the files it ships, no `prepare` or `prepack`, and a global install running a `#!/usr/bin/env jsh` script.

Run one with `node --test --test-timeout=900000 --test-global-setup=node_modules/@ai-ecoverse/slicc-shared-web/harness/global.mjs test/integration/<file>.test.mjs`.

The baselines always run on Node 22.22.0: `$NODE22` if it names that version, else `npx -y node@22.22.0` fetches it once. To record baselines:

```sh
npm run golden:record        # test/golden/fixtures/, on Node 22.22.0
npm run jsh:record           # test/jsh/fixtures/, with the host jsh
```

Fixtures are not published: the package's `files` lists only `dist`, `README.md`, `LICENSE` and `NOTICE`. CI also checks that `NOTICE` names every bundled package and that the tarball holds no `test/` or `scripts/`.

Design and milestones: [slicc-kernel#68](https://github.com/ai-ecoverse/slicc-kernel/issues/68). The comparison harness behind [docs/compare/seven-six-node.md](docs/compare/seven-six-node.md) is in [test/compare/](test/compare/README.md).

**Memory.** Every test script runs with `--max-old-space-size=512`. For heavy runs, wrap the command in `scripts/mem-guard.sh`. It samples RSS every 0.5 s and kills the command's process tree (exit 137) when one process passes 2,000,000 KB (~1.9 GiB) or the whole tree passes 3,000,000 KB (~2.9 GiB). Run one Chromium at a time:

```sh
scripts/mem-guard.sh npm test
lockf -k /tmp/slicc-heavy.lock scripts/mem-guard.sh node --test test/integration/browser-corpus.test.mjs
```

## CI and releases

`.github/workflows/ci.yml` is one caller of [slicc-shared-web's pipeline](https://github.com/ai-ecoverse/slicc-shared-web#pipeline), on Node 26 (the kernel's `engines`; the baselines bring their own Node 22.22.0):

- **pull requests:** `npm run lint` (with `shellcheck` on `install.sh`), then `npm test` with the files of `test/integration/` split by timing over 4 shards, then a Claude and a Codex review. `ci / integration` and `ci / review` are the checks to require;
- **the merge queue:** lint and the tests again, on the tree that lands;
- **a push to `main`:** [semantic-release](https://semantic-release.gitbook.io/) takes the version from the conventional commits since the last `v*` tag and publishes to npm with provenance, through npm trusted publishing from `ci.yml`.

- `feat:` gives a minor release (0.x stays 0.x until a breaking change);
- `fix:` or `perf:` gives a patch release;
- other types (`docs:`, `chore:`, `ci:`, `test:`, …) release nothing.

`version` in `package.json` stays `0.0.0`; semantic-release sets it. `prepack` builds and then runs `scripts/strip-own-scripts.mjs`, which removes `prepare` and `prepack` from `package.json` in CI (or with `SLICC_JSH_STRIP_SCRIPTS=1`) before npm packs, so the published package has neither. A local `npm pack` keeps them. npm trusts `ci.yml` (`fledgling` in `package.json`): `npm run trust` sets that up, `npm run trust:dry` shows what it would do.
