# Workers and IPC: `worker_threads.Worker`, `child_process.fork`, `cluster.fork`

Status: **approved on 2026-10-18 (W-B for workers, F-1 for fork).** The kernel side is K1, [slicc-kernel#1093](https://github.com/ai-ecoverse/slicc-kernel/issues/1093), and K2, [slicc-kernel#1094](https://github.com/ai-ecoverse/slicc-kernel/issues/1094). The open shape questions at the end are settled on those issues. K3 isn't filed yet.

Goal: a repo's tests run on seven as they run on Lars's machine. Today jest, vitest, eslint `--concurrency`, piscina and tinypool, nodemon and `node --watch` fail or fall back, because jsh has no `worker_threads.Worker` and no `child_process.fork` with an IPC channel.

## Where things are today

**jsh** (this repo, main at 616f2e7):
- `child_process` has `spawn`, `exec`, `execFile` (on `ctx.spawn` / `ctx.sync.spawn`) and the sync forms (`ctx.sync.run`). `fork()` throws `ERR_NOT_SUPPORTED`. `'ipc'` in `stdio` is rejected (`toKernelStdio`), and `spawnSync` with it is `ERR_IPC_SYNC_FORK` (`src/runtime/builtins/child-process.mjs`).
- `worker_threads` is the main thread's view only (`src/runtime/cjs/builtins.mjs:277`): `isMainThread` true, `threadId` 0, `parentPort`/`workerData` null, `get`/`setEnvironmentData`, `SHARE_ENV`, and in-process `MessageChannel`, `MessagePort`, `BroadcastChannel` and `receiveMessageOnPort` (`src/runtime/web/broadcast-channel.mjs`). `new Worker()` and `postMessageToThread` throw `ERR_NOT_SUPPORTED`.
- `cluster` is Node's primary (`src/runtime/builtins/cluster.mjs`). `cluster.fork()` throws `ERR_NOT_SUPPORTED`.
- `v8.serialize`/`deserialize` throw `ERR_NOT_SUPPORTED`.
- `vm` contexts are not separate realms. They are objects in front of the program's globals (`src/runtime/builtins/vm.mjs`).
- `--watch` is a `bad option`, for lack of an IPC channel (`docs/compatibility.md`).

**slicc-kernel** (main, v1.125.5):
- Each process is its own Web Worker in the browser, created by the kernel worker (`src/kernel-worker.ts:15`), or its own `worker_thread` on the node host (`src/node-process-worker.ts`). The page must be cross-origin isolated (`src/index.ts:571`). So every process has `SharedArrayBuffer` and `Atomics.wait`, and the kernel's sync lane uses both (`src/process/js/js-kernel.ts:216`).
- The lockdown takes `Worker`, `SharedWorker` and `postMessage` from a JS program, and leaves `BroadcastChannel` an empty slot (`src/process/js/lockdown.ts`). A program can't start a thread or a realm of its own.
- `ctx.spawn(o)` / `ctx.sync.spawn(o)` (`src/process/js/js-children.ts`) take `argv, argv0, env, cwd, pgid, session, parentDeathSignal` and only `stdin`/`stdout`/`stderr`, each `'inherit' | 'pipe' | 'null' | fd`. The child object has `pid`, web streams for the piped three, `wait()` and `kill()`.
- The `proc-spawn` syscall can already do more than the JS ctx lets a program ask for. It has `inherit: InheritedSlot[]`, which installs any of the parent's kernel files at any fd ≥ 3 of the child (`src/kernel/children.ts:243`); WASIX fork/exec uses it. The kernel also has `fd-pipe` and `sock-pair` (AF_UNIX stream socketpair, `src/kernel/socket-syscalls.ts:192`). Neither is on the JS ctx.
- The kernel has **threads**, for WASI/WASIX only: `WASM_THREAD_SPAWN` starts another worker in the same process (same pid, same fd table, its own sync SAB) (`src/kernel/host.ts:661`). For `abi: js` the kernel returns early (`if (done || program.abi === 'js') return;`, host.ts:663).
- There's no message passing between processes other than byte streams. There's no fd passing (no SCM_RIGHTS) and no SO_REUSEPORT.
- `ctx.net.listen`/`connect` give in-kernel loopback TCP.

**Cost of a `node` child today** (measured 2026-10-18 on the node host, an M-series Mac, kernel 1.125.5, `test/integration/helpers.mjs`'s `withJsh`):

| | |
|---|---|
| `spawn('node', ['-e', '0'])` until `'exit'`, one at a time | 90–97 ms |
| 4 at once, until all have exited | 108 ms |
| host RSS with 1 parent + 4 idle `node` children | 383 MB, so about 65 MB per jsh process |

In the browser it's about 120 ms. Start cost is mostly the jsh bundle being evaluated in a fresh worker. It's paid once per pool worker, not once per task.

## What the real consumers use

| consumer | mechanism | what it needs |
|---|---|---|
| **jest 30** (jest-worker), the default | `fork(childWorkerPath, [], { serialization: 'advanced', execArgv, env: { JEST_WORKER_ID }, silent })` | IPC with `'advanced'`: `send`, `'message'`, `'exit'`, `'disconnect'`; `kill('SIGTERM')` then `'SIGKILL'`; `stdout`/`stderr` pipes |
| jest `workerThreads: true` | `new Worker(path, { eval: false, stdout: true, stderr: true, resourceLimits, workerData })` | Worker, piped stdio, `resourceLimits` passed through |
| **vitest 5** (5.0.5; no tinypool any more) `pool: 'forks'`, the default | `fork(entry, [], { env, execArgv, stdio: 'pipe', serialization: 'advanced' })` | as jest; `kill()` then `SIGKILL` |
| vitest 5 `pool: 'threads'` | `new Worker(entry, { env, execArgv, stdout: true, stderr: true })`, `MessageChannel` | Worker, piped stdio, `terminate()` |
| vitest 3.2 / **tinypool 1** | `new Worker(...)` or `fork(...)`. The task port is **transferred** in a message, there's a SAB request counter, and a worker with `useAtomics` (tinypool's default; vitest turns it off) sleeps in **`Atomics.wait`** and then drains with **`receiveMessageOnPort`** | MessagePort transfer, SAB shared across threads, `Atomics.wait`/`notify`, sync receive |
| **piscina 5** | as tinypool, `atomics: 'sync'` by default (also `'async'`: `Atomics.waitAsync`) | same, plus `Piscina.move` (ArrayBuffer transfer) |
| **eslint 9** `--concurrency` | `new Worker(url, { env: SHARE_ENV, workerData: { filePathIndexArray: Uint32Array on a SharedArrayBuffer } })`; workers take files with `Atomics.add` | **one SAB shared by all workers**, `SHARE_ENV`, URL filename |
| **nodemon 3** | `fork(script, args, { stdio: [..., 'ipc'], env })` | `'ipc'` in a `stdio` array |
| **`node --watch`** | Node's `internal/main/watch_mode.js`: `spawn(execPath, args, { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] })`; the child reports `{ 'watch:require': [...] }` / `'watch:import'` | spawn with `'ipc'`, `process.send` in the child, `fs.watch` (slicc-kernel 1.125.0+) |
| cluster users (pm2-like servers, `throng`) | `cluster.fork()`, internal `NODE_CLUSTER` messages, and **handle passing** for a shared `listen()` | fork; handles (see cluster below) |

Two things follow. First, `'advanced'` serialization is on the hot path (jest and vitest both use it), so jsh needs V8's ValueSerializer. Second, sharing one SAB between workers is required, not optional: eslint, tinypool and piscina need it. A Worker whose memory can't be shared with its parent won't run them.

## The Node 22 semantics jsh must give

### `child_process.fork` and the IPC channel

- **`fork(modulePath[, args][, options])`** is `spawn(execPath, [...execArgv, modulePath, ...args], { ...options, stdio })`. `execPath` defaults to `process.execPath` and `execArgv` to `process.execArgv`. `stdio` is `silent ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['inherit', 'inherit', 'inherit', 'ipc']`, or the caller's array, which must contain exactly one `'ipc'` (`ERR_CHILD_PROCESS_IPC_REQUIRED`). `serialization` is `'json'` (default) or `'advanced'`. Node's argument validation and errors apply (`ERR_INVALID_ARG_VALUE` for `stdio` strings other than the three, and so on).
- **`'ipc'` in any `spawn` stdio array** (nodemon, `--watch`, execa's `ipc: true`). One per spawn (`ERR_IPC_ONE_PIPE`), and never in the sync forms (`ERR_IPC_SYNC_FORK`, which jsh already throws). The child gets `NODE_CHANNEL_FD=<index>` and `NODE_CHANNEL_SERIALIZATION_MODE`.
- **Parent side:** `subprocess.send(message[, sendHandle][, options][, callback])` returns `false` under backpressure, and its callback runs when the write is done. `subprocess.connected`, `subprocess.disconnect()`, and `subprocess.channel` with `ref()`/`unref()`. Events: `'message'`, `'disconnect'`. A live channel keeps the parent alive until disconnect or `unref()`.
- **Child side:** at startup, if `NODE_CHANNEL_FD` is set, Node deletes it (and the mode) from `process.env` and sets up `process.send`, `process.connected`, `process.disconnect()`, `process.channel`, and the `'message'` and `'disconnect'` events. As in Node, the child's channel keeps it alive only while it has `'message'` or `'disconnect'` listeners (the golden pins this). Without a channel, `process.send` is `undefined`.
- **Wire format**, so jsh matches Node byte for byte (both ends are jsh, but the goldens compare):
  - `'json'`: `JSON.stringify(message) + '\n'` per message;
  - `'advanced'`: a 4-byte big-endian length, then `v8.serialize(message)` (header, version 15).
  - Messages whose `cmd` starts with `NODE_` are internal: they're emitted as `'internalMessage'`, not `'message'`. cluster depends on this.
- **Order and errors:** a send after disconnect is `ERR_IPC_CHANNEL_CLOSED` (emitted as `'error'` or passed to the callback). An unserializable message throws (`DataCloneError` with `'advanced'`). When the child exits, `'disconnect'`, `'exit'` and `'close'` come in Node's order, which the goldens pin.
- **Handle passing** (`send(msg, socket | server | dgram)`) is **out of scope**. The kernel has no SCM_RIGHTS. `send` with a handle fails with `ERR_NOT_SUPPORTED` on its callback (or as `'error'`), and the plain message isn't sent. What breaks: cluster's shared `listen()` done Node's way (see cluster below for how jsh works around it), and programs that hand sockets to workers themselves (rare; none of the consumers above).
- `detached`, `cwd`, `env`, `uid`/`gid`, `signal` and `timeout` (with `killSignal`) behave as for `spawn`, as now.

### `worker_threads.Worker`

- `new Worker(filename | URL, options)`:
  - `filename` is a path, a `file:` URL or a `data:` URL; `.mjs` and `"type": "module"` decide ESM as for a main script;
  - `eval: true`: the string is a CommonJS script, as Node's `[worker eval]`;
  - `argv` and `execArgv`: the worker's own `--require`/`--import`/`--conditions`. Process-wide flags give `ERR_WORKER_INVALID_EXEC_ARGV`;
  - `env`: a copy of `process.env` by default, an object, or `SHARE_ENV`;
  - `workerData`;
  - `transferList`;
  - `stdin`/`stdout`/`stderr`, `name`, `trackUnmanagedFds`, `resourceLimits`.
- `threadId`: per process, counting from 1. `worker.threadId` matches the worker's `require('worker_threads').threadId`.
- **Inside the worker:** `isMainThread` false, `parentPort`, `workerData`, `threadId`, `resourceLimits`, `getEnvironmentData` (inherited at start). `process.pid` is the parent's (it's the same process). `process.exit(n)` ends the worker only, with `'exit'` code n. `process.chdir`, `process.abort`, `setuid` and the like throw `ERR_WORKER_UNSUPPORTED_OPERATION`. Signals go to the main thread.
- **Messages:** `postMessage(value, transferList)` uses the HTML structured clone, with Node's additions. Transferables are `ArrayBuffer` (detached in the sender) and `MessagePort` (it moves, and keeps its queue). A `SharedArrayBuffer` is shared, not copied: both threads see the same memory, and `Atomics.wait`/`notify`/`waitAsync` work across them. Events are `'message'` and `'messageerror'`. `receiveMessageOnPort(port)` must work on a port whose other end is in another thread, synchronously, including while the receiver has just woken from `Atomics.wait` (tinypool and piscina in `sync` mode).
- **Lifecycle events:** `'online'` once the worker starts running its script. An uncaught exception becomes `'error'` with the error deserialized, then `'exit'` with code 1. `'exit'(code)` is always last. `terminate()` returns `Promise<number>` (1 when it stopped the worker). `ref()`/`unref()` decide whether the worker keeps the parent alive.
- **stdio:** the worker's `process.stdout`/`stderr` go to the parent. By default they're piped into the parent's own stdout/stderr. With `stdout: true` / `stderr: true` they're only `worker.stdout` / `worker.stderr`, readable streams (jest and vitest use this). `stdin: true` gives `worker.stdin`.
- **`resourceLimits`:** jsh accepts and validates it, and reports it on both sides (`worker.resourceLimits`, `require('worker_threads').resourceLimits`). It is **not enforced**: a Web Worker's heap can't be capped. If the kernel tells jsh a worker ran out of memory, the parent gets `'error'` with `ERR_WORKER_OUT_OF_MEMORY` and then `'exit'` 1.
- **`env: SHARE_ENV`:** the threads share one environment. A write in one thread is seen by the others, as in Node. eslint passes it and only reads.
- **`Atomics` and `SharedArrayBuffer`:** they exist in every kernel realm, because the kernel requires a cross-origin isolated page and runs its own sync lane on them. `Atomics.wait` is allowed in process workers, the main thread included, as in Node. What a design must keep is that **all of a program's threads are in one agent cluster**, so that a SAB can be posted between them (see slicc-kernel#979, "process workers in more than one renderer", which would split them).
- Not in scope: `getHeapSnapshot`, `performance.eventLoopUtilization` for a worker, `moveMessagePortToContext`, `markAsUncloneable`. Each throws `ERR_NOT_SUPPORTED` or is a no-op, as documented. `postMessageToThread` and cross-thread `BroadcastChannel` come later, routed through the main thread.

### `cluster.fork` on top of `fork`

- Node's own `lib/internal/cluster/{primary,child,worker,utils}.js` logic: `fork(settings.exec, settings.args, { env: { ...env, NODE_UNIQUE_ID: id }, execArgv, silent, serialization, stdio, cwd, uid, gid })`. Workers talk to the primary with internal `NODE_CLUSTER` messages. In a child, `cluster.isWorker` is decided by `NODE_UNIQUE_ID`.
- The events: `'fork'`, `'online'`, `'listening'`, `'message'`, `'disconnect'` and `'exit'` on both the cluster and the worker. `worker.disconnect()`, `kill()`, `exitedAfterDisconnect`, `isDead()`, `isConnected()`, and `cluster.disconnect()`.
- **`listen()` in a worker** (the reason most programs use cluster): in Node, the worker asks the primary (`queryServer`), and the primary either accepts and passes each socket (`SCHED_RR`) or passes the listening handle (`SCHED_NONE`). Both need handle passing. Without it, jsh's primary owns the listener. The worker listens on an ephemeral loopback port that it reports to the primary, and the primary pipes each accepted connection to a worker, round robin. What differs from Node: `socket.remoteAddress` in the worker is the loopback, there's one extra in-kernel hop, and `SCHED_NONE` behaves as `SCHED_RR`. With fd passing (K3 below) this becomes Node's real round robin.

## Implementation options

### For `worker_threads.Worker`

| | **W-A: a realm in the same thread** | **W-B: a kernel thread of the same process** | **W-C: a separate kernel process** |
|---|---|---|---|
| what it is | jsh runs the worker's module graph in the same JS thread, with its own `process`/globals shim | the kernel starts another process worker (same pid, fd table, cwd, creds) running the jsh bundle, entangled with the parent by a native `MessagePort`, as it already does for WASIX threads | `ctx.spawn` of `node` with a message channel; the "thread" is a child process |
| start cost | module graph only (ms) | a worker plus jsh start-up, about 90 ms (less the process set-up) | as a `node` child today, 90–120 ms |
| memory | small (shares the heap) | about 65 MB per worker | about 65 MB per worker, plus a process entry |
| parallelism | none | real | real |
| SAB / Atomics | the same memory trivially, but `Atomics.wait` in a worker **deadlocks the program**: the parent can't run to notify it (piscina `sync`, tinypool `useAtomics`) | native: a SAB posted between threads is shared memory; `wait`/`notify`/`waitAsync` work | only if the kernel's channel carries native structured clone between process workers in one agent cluster; over a byte pipe, impossible (eslint's shared counter breaks) |
| fidelity | low: one realm, so `globalThis` and prototype changes leak between workers (vitest's jsdom environment sets `globalThis.window`); no `vm`-grade isolation | high: `process.pid` shared, `threadId`, `process.exit` ends one thread, a crash is the worker's | medium: different pid, own fd table and cwd, extra entries in `ps`, signals and `kill` see a process |
| kernel change | none | JS threads (K2) | a message channel on spawn |

**Recommendation: W-B.** It's what Node does: threads of one process. Structured clone, transfer and SAB sharing come from the platform, not from jsh. The kernel already has the machinery, for WASIX. W-A isn't safe for vitest or piscina. W-C costs the same and is less faithful. I don't propose W-A even as a fallback on older kernels: there, `new Worker()` keeps throwing `ERR_NOT_SUPPORTED`, unchanged.

### For `fork` and `'ipc'`

| | **F-1: an fd-3 socketpair (Node's `NODE_CHANNEL_FD`)** | **F-2: a native message channel on spawn** | **F-3: loopback TCP, no kernel change** |
|---|---|---|---|
| what it is | the parent makes an AF_UNIX stream socketpair and passes one end to the child at fd `n`; jsh writes Node's framing on it | `ctx.spawn({ channel: true })` gives `child.port` and `ctx.parentPort`, native `MessagePort`s | the parent listens on `127.0.0.1:0`; the child connects, with the port and a token in the env |
| start cost | spawn + one syscall | spawn | spawn + listen + connect (a few ms) |
| `'advanced'` | jsh's V8 serializer over the bytes, as Node does | native structured clone (not V8's format; for example `Error`s and their own properties differ) | as F-1 |
| fidelity | high: a real fd, inherited and closed as in Node; wasm programs could use it; handle passing can be added on it (K3) | medium: no fd, so `stdio[n]`, inheritance by grandchildren and handle passing don't exist; only JS processes; the agent-cluster issue of slicc-kernel#979 | low to medium: another process could connect (the token mitigates it); not an fd; the port shows up in the kernel's net |
| kernel change | expose two things the kernel already has (K1) | new | none |

**Recommendation: F-1.** Node's channel is a byte stream between two processes, and Node sends `'advanced'` messages as V8 serializations, not as shared memory. A `SharedArrayBuffer` can't cross Node's IPC either. So F-1 loses nothing that Node has, and F-2's extra power isn't needed. F-3 could ship `fork` before the kernel side lands, but it would be a second transport to keep, and every stage is gated on its kernel anyway. I'd only use it if K1 slips.

## Kernel asks

Filed by the Kernel Coordinator as slicc-kernel#1093 (K1) and slicc-kernel#1094 (K2). Each one adds API to the JS ctx, and jsh feature-detects it (`typeof ctx.socketpair === 'function'`, `ctx.thread`) as well as checking `ctx.kernel.version`.

**K1 ([slicc-kernel#1093](https://github.com/ai-ecoverse/slicc-kernel/issues/1093)): fds for children, for `fork`, `'ipc'` and `--watch`.** Needed by stage 1.
1. `ctx.socketpair(): Promise<[number, number]>` and `ctx.sync.socketpair(): [number, number]`: an AF_UNIX stream pair, two fds of the calling process (the existing `sock-pair` with `domain: 'unix', type: 'stream'`).
2. On `JsSpawnOptions` (async and sync): `fds?: Record<number, number>`, where `{ 3: f }` installs the caller's fd `f` at fd 3 of the child. This maps to `proc-spawn`'s existing `inherit: [{ fd: 3, kernel: f }]`. Keys must be ≥ 3; `stdin`/`stdout`/`stderr` stay as they are. The parent keeps its own `f`, and jsh closes it after the spawn.
3. Confirm, with a test on the kernel side, that `ctx.read`/`ctx.write`/`ctx.close` and their `ctx.sync` forms work on a socket fd:
   - `read` resolves with what's there and returns zero bytes at the peer's EOF;
   - a `read` that is pending when the fd is closed resolves (EOF or `EBADF`) and doesn't hang;
   - `write` to a closed peer raises SIGPIPE, the kernel's default, as on Linux. Node ignores SIGPIPE, so jsh calls `ctx.signals.ignore('SIGPIPE')` and gets `EPIPE` (settled; slicc-kernel#1093 pins it with a test).
4. Nice to have, on the same shape: Node's extra `stdio` pipes (`stdio: ['pipe', 'pipe', 'pipe', 'pipe']`) need nothing more than `fds` plus `ctx.pipe()`. Exposing `fd-pipe` as `ctx.pipe()` / `ctx.sync.pipe()` would cover them.

**K2 ([slicc-kernel#1094](https://github.com/ai-ecoverse/slicc-kernel/issues/1094)): JS threads, for `worker_threads.Worker`.** Needed by stage 2.
1. `ctx.thread.spawn({ data, transfer }): Promise<JsThread>`, with `JsThread = { tid, port: MessagePort, exited: Promise<number>, terminate(): Promise<void> }`. It does for `abi: js` what `WASM_THREAD_SPAWN` does for WASI:
   - a new process worker in the same process (same pid, fd table, cwd, umask, creds), with its own sync-lane SAB;
   - the kernel's lockdown, applied as in the main thread;
   - the same program module (`dist/node.mjs`), run with a ctx whose `ctx.thread = { tid, port, data }`. In the main thread, `ctx.thread.tid` is 0 or `ctx.thread.port` is undefined.
   - The kernel makes a `MessageChannel` and transfers one port to each side. `data` is structured-cloned with `transfer`, and goes to the new worker in its init message.
2. **The channel must carry native structured clone between the two workers:** a `SharedArrayBuffer` shared, `ArrayBuffer`s and `MessagePort`s transferred. That holds as long as both workers are in one agent cluster, which is true today. It must stay true for a process's threads if slicc-kernel#979 lands.
3. Exit:
   - `ctx.exit(n)` in a thread ends that thread only, and `exited` resolves with `n`;
   - `terminate()` ends it with 1;
   - the process ends when its main thread exits, and takes its threads with it;
   - a thread that runs out of memory or crashes resolves `exited` with a code jsh can tell apart (the existing `NO_MEMORY` / `CRASHED`), so jsh can raise `ERR_WORKER_OUT_OF_MEMORY`.
4. Signals go to the main thread only. `proc-wait` and the process's status don't change when a thread exits.
5. A cap on threads per process, as WASI has (`WASM_MAX_THREADS`). Past it, `spawn` fails with `EAGAIN`, which jsh reports as `ERR_WORKER_INIT_FAILED`.

**K3 (later, optional): fd passing on a unix socket**, for handle passing and cluster's real round robin: `ctx.sendFd(sock, fd)` / `ctx.recvFd(sock)` (SCM_RIGHTS-like; the fd table already retains files across processes). Not needed for stages 1–4.

**Not asked:** a structured-clone transport for `fork` (jsh writes V8's format itself), an SAB-capable worker (every process worker already has SAB and `Atomics.wait`), and a message channel on `ctx.spawn` (F-2).

## jsh-side design

**V8 ValueSerializer in JS.** jsh implements V8's serialization format, version 15, behind `v8.Serializer`/`Deserializer`, and from it `v8.serialize`/`deserialize`. That turns two `ERR_NOT_SUPPORTED`s into working APIs.
- Node's `lib/v8.js` `DefaultSerializer` and `lib/internal/child_process/serialization.js` are JS, so they're vendored unchanged, as `node-lib` does for other files.
- The serializer covers primitives, objects and arrays (dense and sparse), Date, RegExp, Map, Set, the boxed primitives, BigInt, ArrayBuffer, the typed arrays and DataView (Node's host objects), and Errors (V8's error tag: name, message, stack, cause).
- Circular references are back-references. A `SharedArrayBuffer` and a transferred `MessagePort` are ids handed to the delegate.
- The goldens compare its bytes with host Node's `v8.serialize`.

**The channel** (stage 1) is Node's `setupChannel` logic (`lib/internal/child_process.js`) over a small handle on an fd:
- reads are `ctx.read(fd)` in a loop, tracked as a ref'able handle;
- writes are `ctx.write(fd, bytes)`, queued, with `send`'s return value and callback;
- `'json'` and `'advanced'` framing comes from the vendored `serialization.js`;
- internal `NODE_` messages, `disconnect`, and the ordering against `'exit'`/`'close'` follow Node.
- On the child side, the channel is set up in jsh's bootstrap when `NODE_CHANNEL_FD` is set and the fd is a socket (`ctx.fdStatus`).

**`--watch`** (stage 1b) is Node's `internal/main/watch_mode.js`: the watch process spawns the program with `'ipc'`, and the child reports the files it loads (`--watch-report-ipc`). This uses `fs.watch` from slicc-kernel 1.125.0. `--watch-path` and `--watch-preserve-output` come with it.

**Workers** (stage 2):
- The main thread calls `ctx.thread.spawn`. `data` has the filename or eval source, argv, execArgv, the env snapshot (or the SHARE_ENV marker), `workerData`, environment data, `threadId`, `name`, the stdio flags and `resourceLimits`. `transfer` is the native transferables in `transferList`.
- The worker side boots jsh in worker mode from `ctx.thread`: `isMainThread` false, `parentPort` over the thread port, and so on.
- **Cross-thread `MessagePort`s.** jsh's in-process ports stay as they are. When a port crosses to another thread, jsh replaces it with a native `MessageChannel` end, which the platform transfers.
- **`receiveMessageOnPort` across threads** needs a synchronous queue, because a native port only delivers on the event loop, and tinypool and piscina wake from `Atomics.wait` and read at once. So each cross-thread port pair also shares a **SAB mailbox**:
  - `postMessage` writes the message's V8 serialization into the mailbox, `Atomics.notify`s, and the receiver's event loop drains it with `Atomics.waitAsync`;
  - the SABs and ports inside a message go on the native port as a side-car, keyed by sequence number;
  - a transferred `ArrayBuffer` is copied and then detached in the sender (`structuredClone(buf, { transfer: [buf] })`);
  - `receiveMessageOnPort` reads the mailbox synchronously. The one case it can't serve is a message whose side-car (a SAB or port inside it) hasn't arrived yet. It returns `undefined` for that message, which then comes through `'message'`. Documented; tinypool's and piscina's task messages don't carry those.
- **stdio:** the worker's `process.stdout`/`stderr` write chunks over an internal port to the parent. There, `worker.stdout`/`stderr` are `Readable`s, piped to the parent's stdout/stderr unless `stdout: true` / `stderr: true`.
- **`SHARE_ENV`:** each thread's `process.env` writes through to an env object owned by the main thread, and the change goes to the other threads through the mailboxes. So there's a short window in which another thread hasn't seen a write yet. Node's is immediate, and this is documented.

**cluster** (stage 3): `cluster.fork` on `fork`. The worker side is Node's `child.js` logic, and `listen()` goes through the primary as described above.

## Stages

Each is one `feat:` PR. Each is gated on the kernel version that provides its kernel side (`kernelAtLeast` plus feature detection). On older kernels everything stays as it is today, and the existing `ERR_NOT_SUPPORTED` tests keep passing there.

1. **fork + IPC** on K1: `fork`, `'ipc'` in `spawn`, the child's `process.send`, and the V8 serializer (with `v8.serialize`/`deserialize`). 1b, in its own PR: `node --watch`.
2. **`worker_threads.Worker`** on K2.
3. **`cluster.fork`** on stage 1, with `listen()` through the primary.
4. **Real projects green**, in the browser too. Each stage brings its own real-project tests; stage 4 adds the rest and the browser runs.

## Test plan

These follow Lars's rules: behaviour tests with the real packages, no mocks of jsh internals, and each test fails without the change. Today they all fail with `ERR_NOT_SUPPORTED`, or jest/vitest/eslint fall back. Tests wait on progress, such as a summary line or an `'exit'`, never on wall-clock time, with no retries and no raised timeouts (#451).

**Goldens against host Node 22.22.0** (`scripts/golden.mjs`):
- **fork:**
  - `fork-json` and `fork-advanced`: Map, Set, Date, BigInt, typed arrays, Error with cause, circular, sparse array;
  - `fork-order`: messages before exit, then `'disconnect'`, `'exit'`, `'close'`;
  - `fork-silent-stdio` and `spawn-ipc-index`: `'ipc'` at index 3 and 4, `NODE_CHANNEL_FD`, and the env vars gone in the child;
  - `fork-liveness`: the parent stays alive while connected; the child is kept alive only by `'message'` listeners; `channel.unref()`;
  - `fork-errors`: `ERR_IPC_CHANNEL_CLOSED`, `ERR_IPC_ONE_PIPE`, `ERR_CHILD_PROCESS_IPC_REQUIRED`, send with a handle, a `DataCloneError`;
  - `v8-serialize`: bytes compared with Node's.
- **worker:**
  - `worker-basic`: `workerData`, `parentPort`, `threadId`, `isMainThread`, `'online'`, the shared `process.pid`;
  - `worker-transfer`: `ArrayBuffer` detached, `MessagePort` moved with queued messages, a SAB with `Atomics.wait`/`notify` both ways;
  - `worker-receive-sync`: `receiveMessageOnPort` after `Atomics.wait`;
  - `worker-exit`: `process.exit(3)`; uncaught error gives `'error'` then `'exit'` 1; `terminate()` resolves 1;
  - `worker-eval-esm-url`;
  - `worker-stdio`: default piping and `stdout: true`;
  - `worker-env`: copy and `SHARE_ENV`;
  - `worker-unref`;
  - `worker-unsupported`: `process.chdir` gives `ERR_WORKER_UNSUPPORTED_OPERATION`;
  - `worker-resource-limits`;
  - `worker-environment-data`.
- **cluster:** `cluster-fork-messages`, `cluster-http-rr` (an http server in two workers, requests answered by both; the golden prints sorted worker ids, not the order), `cluster-disconnect` (`exitedAfterDisconnect`).

**Real projects** (`test/integration`, pinned as devDependencies, written into the kernel with `devPackageTree`):
1. **jest 30**: a fixture with three test files, run with `jest --maxWorkers=2 --no-cache`. With no cache there are no timings, so jest can't choose to run in band. Each test checks that `JEST_WORKER_ID` is set and that `process.pid` isn't the runner's, which proves that workers ran it. The same fixture also runs with `workerThreads: true` (stage 2).
2. **vitest 5**: `vitest run --pool=forks` and `--pool=threads` over three files, asserting the summary. Also **vitest 3.2** (tinypool) `--pool=threads`, because many repos are still on 3.x.
3. **tinypool 1** directly with `useAtomics: true`, and **piscina 5** with its default `atomics: 'sync'` and with `Piscina.move`. These exercise `Atomics.wait` plus `receiveMessageOnPort` across threads.
4. **eslint 9** `--concurrency=2` over four files: the shared SAB counter and `SHARE_ENV`.
5. **nodemon 3** and **`node --watch`**: start, change a file with `kernel.writeFile`, wait for the restart output, then stop. This is cheap once stage 1b is in.
6. **Browser** (`test/browser`, `SLICC_CDP_PORTS=9300-9309`): jest and piscina once each, since W-B's agent cluster and SAB sharing in Chrome are what Lars's seven runs on, and the node host differs there.

Memory: an 8-worker vitest run is about 9 × 65 MB on the node host, well within `scripts/mem-guard.sh`. The tests use 2 workers.

## Open questions for the kernel side

These are settled on slicc-kernel#1093 and slicc-kernel#1094.

- K1: is `fds: Record<number, number>` the right shape, or should it be an array of `{ fd, from }`? What about the sync form's fd lifetimes?
- K2: should a thread run the same module export with `ctx.thread`, or a named `thread` export of the module? Should the port be a native `MessagePort` (simplest, and what gives SAB sharing), or a kernel-wrapped object? And how should a thread's exit code show OOM?
- K2: what is the per-process thread cap, and how does it count against the renderer's worker budget (slicc-kernel#979)?
