# @ai-ecoverse/slicc-jsh

slicc-jsh gives [slicc-kernel](https://github.com/ai-ecoverse/slicc-kernel) a Node.js 22-compatible `node` command, and a `jsh` command that runs `.jsh` scripts. It also ships a host `jsh` CLI that runs the same `.jsh` scripts on a normal machine, on the machine's own Node 22.

- [Install](#install)
- [Quick start](#quick-start)
- [Node compatibility](#node-compatibility)
- [Kernel requirements](#kernel-requirements)
- [Develop](#develop)
- [Release](#release)

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

The release line of each GitHub release (`… integrity=sha512-… …`) carries the same value, checked against the registry when it was published. Only a `sha512-` value is accepted; other algorithms and malformed values are refused before anything is downloaded. The pin covers the jsh tarball, not the installer script or the private Node.

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
| `skill` | `dir` is the script's directory, and `config()` reads and writes `.config` there; `root` is the skill folder (the parent of a `scripts/` directory), with `refs` and `assets` in it; `token(id)` runs `oauth-token <id>` |

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

The package needs `slicc-kernel` 1.53.2 or later. These features need a newer kernel:

| Feature | slicc-kernel | On an older kernel |
|---|---|---|
| a refused `WebSocket` connect is an `error` event with `cause.code` | 1.59.1 | |
| `spawnSync`, `execSync`, `execFileSync`, `process.execve` | 1.65.0 | they throw, naming the kernel version needed |
| `process.exit()` ends the program inside the call | 1.65 | code it unwinds through still runs, silenced |
| `/dev` through `fs` (`/dev/null`, `/dev/urandom`, …) | 1.69 | |
| sync `child_process`: the program's own fds go to the child, output order kept on one fd | 1.70.0 | other fds are written after the run, stdout before stderr |
| `process.kill(self)` and `process.abort()` end the program inside the call; `kill` of other processes | 1.72.0 | the program unwinds, silenced; other pids give `ESRCH` |
| `fs.statfs` reports the storage quota and usage | 1.72 | a fixed 1 GiB |
| `child_process` `detached: true` makes a new session and process group | 1.74.0 | the child stays in the program's group |
| a child sees `options.argv0` as its `argv[0]` | 1.76.0 | `argv0` only shows in error messages |
| `process.setuid`, `setgid`, `seteuid`, `setegid`, `setgroups`, `initgroups` | 1.81.0 | not defined |
| `fs.chmod`, `fchmod` and `FileHandle.chmod` change the mode; new files get the mode asked for, less the umask; `copyFile` keeps the source's mode | 1.86.0 | they change nothing; new files get the kernel's default mode |
| `fs.mkdir` without `recursive` is exclusive (`EEXIST`/`ENOENT` from the kernel; one winner among processes) | 1.86.0 | it checks, then creates, and makes a missing parent |
| `child.pid` is set when `spawn()` returns | 1.87.0 | it is set by the `'spawn'` event |
| a recursive `fs.rm` is one kernel call | 1.88.0 | jsh walks the tree |
| `process.umask(mask)` sets the kernel's umask (children inherit it); new files are created with their mode | 1.92.0 | jsh's own umask; it `chmod`s new files after (1.86.0+) |
| the `BroadcastChannel` global | 1.92.0 | `undefined`; `worker_threads.BroadcastChannel` has it |
| `tls.connect` for HTTP/1.1 and WebSocket (the transport's TLS), `https` with an agent, `wss://` | 1.116.0 | `tls.connect` throws `ERR_NOT_SUPPORTED` |
| TLS to a host the uplink routes, in the kernel: any port and protocol, a custom `ca`, STARTTLS (`tls.connect({ socket })`, `new tls.TLSSocket(socket)`), the server's certificate | 1.124.0 | those throw or fail with `ERR_NOT_SUPPORTED` |

## Develop

```sh
npm ci
npm run build                # esbuild: dist/node.mjs, dist/jsh.mjs, dist/vendor/, dist/host/
npm run lint
```

The kernel loads `abi: "js"` modules from `data:` URLs, where relative imports don't resolve. So each program entry is bundled into one file.

| Command | What it covers |
|---|---|
| `npm test` | `test:golden`, `test:jsh` and `test:integration`; what a release runs |
| `npm run test:golden` | each fixture in `test/golden/fixtures/` on host Node 22.22.0 and on `node` in slicc-kernel's Node entry: stdout, stderr and status, byte for byte |
| `npm run test:jsh` | each `.jsh` case in `test/jsh/fixtures/` on the host `jsh` (the baseline) and on the kernel `jsh` |
| `npm run test:integration` | `node:test` suites in `test/integration/` on slicc-kernel's Node entry: child processes, `pnpm add -g`, ESM, HTTP, WebSocket, exit and signals |
| `npm run test:cert` | the differential cases in `test/integration/cert/`: host Node 22 against the shim, with the kernel loaded from a plain `dist` path |
| `npm run test:node-parallel` | a slice of Node v22.22.0's own `test/parallel` with Node's `test/common`, in batches of 40 per process. Reports pass/fail; `STRICT=1` fails on any FAIL, `ONLY=<regex>` runs a subset |
| `npm run test:browser` | the kernel in a Chromium tab, with slicc-jsh and `@ai-ecoverse/sliccy-browser` installed by `pnpm add -g`; `sliccy:browser` and its skills corpus, compared with the host `jsh`. `JSH_TARBALL=/path/to.tgz` and `SLICCY_BROWSER` (a version or a local tarball) pin a release |
| `sh test/install/run.sh [node\|no-node\|pty\|uninstall]` | `install.sh` in throwaway `HOME`s, against the published package (needs curl, Node 22+, python3 and perl) |

The baselines always run on Node 22.22.0: `$NODE22` if it names that version, else `npx -y node@22.22.0` fetches it once. To record baselines:

```sh
npm run golden:record        # test/golden/fixtures/, on Node 22.22.0
npm run jsh:record           # test/jsh/fixtures/, with the host jsh
```

Fixtures are not published: the package's `files` lists only `dist`, `README.md`, `LICENSE` and `NOTICE`. CI also checks that `NOTICE` names every bundled package and that the tarball holds no `test/` or `scripts/`.

Design and milestones: [slicc-kernel#68](https://github.com/ai-ecoverse/slicc-kernel/issues/68). The comparison harness behind [docs/compare/seven-six-node.md](docs/compare/seven-six-node.md) is in [test/compare/](test/compare/README.md).

**Memory.** Every test script runs with `--max-old-space-size=512`. For heavy runs, wrap the command in `scripts/mem-guard.sh`. It samples RSS every 0.5 s and kills the command's process tree (exit 137) when one process passes 2,000,000 KB (~1.9 GiB) or the whole tree passes 3,000,000 KB (~2.9 GiB). Run one Chromium at a time:

```sh
scripts/mem-guard.sh npm run test:integration
lockf -k /tmp/slicc-heavy.lock scripts/mem-guard.sh npm run test:browser
```

## Release

[semantic-release](https://semantic-release.gitbook.io/) releases on every push to `main` (`.github/workflows/release.yml`). It runs `npm run lint` and `npm test`, then takes the version from the conventional commits since the last `v*` tag:

- `feat:` gives a minor release (0.x stays 0.x until a breaking change);
- `fix:` or `perf:` gives a patch release;
- other types (`docs:`, `chore:`, `ci:`, `test:`, …) release nothing.

**Certify in the PR, release simply.** cert-review (`.github/workflows/cert-review.yml`, called by `ci.yml` as the `cert` job) certifies the change in the pull request, so only certified changes merge:

- **scope:** `scripts/cert-review/shipped.mjs` decides whether the pull request changes shipped behaviour. It's a conservative path filter: `src/`, the build and notice scripts, LICENSE, NOTICE, README, `install.sh`, `.releaserc.json`, the build and publish workflows (`release.yml`, `ci.yml`), and cert-review's own workflow and tools. A `package.json` or lockfile change counts only if a `package.json` field other than `devDependencies`, `version` and `gitHead` changes, `scripts` included (install hooks run on the consumer's `npm install`, and pack or publish hooks change what ships), or if `dist/` builds differently. So devDependency bumps (kernels, wasm-*, the cert-kernel aliases) are recorded as "not behaviour", and CI's suites still test them.
- **review** (same-repo pull requests that change behaviour and aren't drafts, on opened, ready_for_review, reopened and every push; a draft's required check (`cert / cert-review / verdict`) is red, `draft, not reviewed`, and converted_to_draft cancels a running review; a label event re-runs CI on the head as before, so it restarts the review at full cost until cert-review v2): the candidate (the pull request merged onto current main, `refs/pull/<n>/merge`) and its base (main) are packed as the release packs. The suites and the m-fixtures run on the CI pool (`vars.CERT_RUNNER`), on the candidate's tests with its dist and with main's dist (the NEGATIVE), on four kernels under users `enforce`. Claude reviews the evidence from `test/cert-review/review.txt`. `scripts/cert-review/record.mjs` (main's copy, at the base) writes the line, a `cert-review` status on the head and a sticky comment on the pull request. A fork's pull request that changes shipped behaviour fails: it gets no review.
- **Draft status replaces the old `merge-ok` label, and it's the author's:** whoever opens the pull request marks it ready once it is, and then queues it with `gh pr merge <n> --auto`. **Mark ready = reviewed, and merges on green**; a pull request held for anything stays a draft. No human sits in the loop. Renovate's pull requests aren't drafts, so a dependency bump that changes `dist/` is reviewed before it automerges, and the rest record "not behaviour".
- **cert-review's own changes, and what decides whether it runs and what gets published** (`.github/workflows/cert*.yml`, `ci.yml`, `release.yml`, `scripts/cert-review/`, `scripts/release-{line,body,outcome}.mjs`, `.releaserc.json`, `test/cert-review/`, `test/fixtures/cert-review/`) also go through slicc-shared-web's `cert-self-guard` (a pinned `uses:`). Such a pull request fails `cert-review` with "needs coordinator review" until the lane coordinator applies `cert-review-approved` to its current head. The label is bound to the head's arrival on the server and removed on any later push, and the merge group checks it again. **Only a lane coordinator applies or removes that label**, after reading the change; workers and authors never do. Marking ready stays the author's. CODEOWNERS lists these paths as documentation; no code-owner review is required, because a required review would put a human back in the loop. **Residual:** a `pull_request` run takes its workflow YAML from the pull request, so a pull request that edits `cert-review.yml` could weaken the guard in its own run. The coordinator rule covers that.
- **merge group:** no second review. `scripts/cert-review/group.mjs` checks that every pull request in the group has a successful `cert-review` status on the head that entered the queue, while ci's suites run on the tree that lands. It writes a `cert-review` status on the group's head, which becomes main's tip, so every main commit and every release tag carries one. The release's verify job lists every pull request in the release, with its line, in the GitHub release.

Every push to main releases what landed:

1. **tag** (the CI pool, `vars.CERT_RUNNER`): semantic-release computes the version, tags the commit and writes the GitHub release. `npmPublish` is off: publishing is the next job's.
2. **publish** (hosted, the only job with `id-token: write`): `npm publish --provenance` of exactly the tagged commit, with trusted publishing.
3. **verify** (code only): `scripts/cert-review/published.mjs` re-downloads the registry copy and checks it: integrity = SLSA subject, provenance `release.yml` on `refs/heads/main`, gitCommit = gitHead = tag, on main, `npm audit signatures`, and `latest`. A mismatch opens a supply-chain alert issue. Then `scripts/release-line.mjs` writes the release line into the GitHub release.

`version` in `package.json` stays `0.0.0`; the publish job sets it. `prepack` builds and then runs `scripts/strip-own-scripts.mjs`, which removes `prepare` and `prepack` from `package.json` in CI (or with `SLICC_JSH_STRIP_SCRIPTS=1`) before npm packs, so the published package has neither. A local `npm pack` keeps them. npm has to trust `release.yml` once: `npm run trust` (fledgling) sets that up, `npm run trust:dry` shows what it would do.
