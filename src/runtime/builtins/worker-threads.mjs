/**
 * node:worker_threads (Node 22.22.0) on the kernel's JS threads
 * (ctx.thread, ai-ecoverse/slicc-kernel#1094): a Worker is a thread of this
 * process, running jsh's own entry with the worker's data, as Node runs a
 * new isolate in its process. Without ctx.thread there is only the main
 * thread, as before: `new Worker()` throws ERR_NOT_SUPPORTED.
 *
 * The thread's native port carries the Worker's control, in order:
 * 'online', the worker's stdout and stderr, its uncaught error, and 'bye'
 * with its exit code (and how many messages its parent port sent) just
 * before it ends. The parent port has a native channel of its own, as
 * Node's public port is apart from its internal one, so a worker can
 * transfer its parentPort and still print and exit. What a worker posts or
 * prints before it exits comes before its 'exit'. The kernel's `exited`
 * ends the Worker when the thread ended without a word (terminate(), or a
 * crash).
 *
 * Thread ids count per process from 1, as Node's do, on a counter in shared
 * memory every thread of the program has.
 */
import { EventEmitter } from './events.mjs';
import { nodeError, ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, validateObject } from '../node-errors.mjs';
import { workerExecArgvError, workerNodeOptionsError } from '../cli.mjs';
import { queueMicrotask } from '../async-context.mjs';

export const SHARE_ENV = Symbol.for('nodejs.worker_threads.SHARE_ENV');

const kPublicPort = Symbol('kPublicPort');
const kHandle = Symbol('kHandle');
const WORKER_KIND = 'slicc-jsh worker';

// Node 22's defaults for a worker's resourceLimits (64-bit).
const DEFAULT_LIMITS = { maxYoungGenerationSizeMb: 48, maxOldGenerationSizeMb: 2048, codeRangeSizeMb: 0, stackSizeMb: 4 };
const LIMIT_KEYS = Object.keys(DEFAULT_LIMITS);

/** The worker's own data, when this program is a worker's thread. */
export function workerDataOf(ctx) {
  const data = ctx?.thread?.tid ? ctx.thread.data : undefined;
  return data && data.kind === WORKER_KIND ? data : null;
}

/**
 * A worker thread's context: fds 0–2 go to and from its Worker over the
 * thread's port (they are pipes, never a terminal), and its exit tells the
 * Worker its code first, and how many messages its parent port sent
 * (`sentBy`, once worker_threads has it).
 */
export function workerContext(ctx, data) {
  const port = ctx.thread.port;
  let sent = () => 0;
  const onParentInput = (fn) => {
    port.onmessage = (event) => {
      const message = event.data;
      if (message?.t === 'in' || message?.t === 'in-end') fn(message);
    };
  };
  const encoder = new TextEncoder();
  const bytes = (chunk) => (typeof chunk === 'string' ? encoder.encode(chunk) : new Uint8Array(chunk));
  const out = (fd, chunk) => {
    const copy = bytes(chunk).slice();
    port.postMessage({ t: 'out', fd, chunk: copy }, [copy.buffer]);
  };
  // stdin: what the Worker writes to worker.stdin (stdin: true), else EOF.
  const input = [];
  const readers = [];
  let ended = !data.stdin;
  const settle = () => {
    while (readers.length && (input.length || ended)) readers.shift()(input.shift() ?? new Uint8Array(0));
  };
  onParentInput((message) => {
    if (message.t === 'in') input.push(message.chunk);
    else if (message.t === 'in-end') ended = true;
    settle();
  });
  const readStdin = () =>
    new Promise((resolve) => {
      readers.push(resolve);
      settle();
    });
  const pipe = { type: 'pipe', tty: false, seekable: false };
  let said = false;
  const bye = (code) => {
    if (said) return;
    said = true;
    try {
      port.postMessage({ t: 'bye', code: code & 0xff, sent: sent() });
    } catch {
      /* the Worker is gone */
    }
  };
  const sync = Object.create(ctx.sync, {
    write: {
      value: (fd, chunk) => (fd === 1 || fd === 2 ? out(fd, chunk) : ctx.sync.write(fd, chunk)),
    },
    exit: {
      value: (status = 0) => {
        bye(status);
        return ctx.sync.exit(status);
      },
    },
  });
  const wrapped = Object.create(ctx, {
    argv: { value: ['node'] },
    // The parent's directory when it made the Worker (the process's, in Node).
    cwd: { value: data.cwd ?? ctx.cwd },
    env: { value: { ...data.env } },
    sync: { value: sync },
    write: { value: async (fd, chunk) => (fd === 1 || fd === 2 ? out(fd, chunk) : ctx.write(fd, chunk)) },
    read: { value: (fd, max) => (fd === 0 ? readStdin() : ctx.read(fd, max)) },
    isatty: { value: async (fd) => (fd <= 2 ? false : ctx.isatty(fd)) },
    fdStatus: { value: async (fd) => (fd <= 2 ? pipe : ctx.fdStatus(fd)) },
    stdin: {
      value: new ReadableStream({
        async pull(controller) {
          const chunk = await readStdin();
          if (chunk.length) controller.enqueue(chunk);
          else controller.close();
        },
      }),
    },
    stdout: { value: new WritableStream({ write: (chunk) => out(1, chunk) }) },
    stderr: { value: new WritableStream({ write: (chunk) => out(2, chunk) }) },
    exit: {
      value: (status = 0) => {
        bye(status);
        return ctx.exit(status);
      },
    },
  });
  return {
    ctx: wrapped,
    bye,
    online: () => port.postMessage({ t: 'online' }),
    // An uncaught exception: the Worker's 'error' (Node's serialized error), then exit 1.
    error: (err) => {
      try {
        port.postMessage({ t: 'error', error: err });
      } catch {
        port.postMessage({
          t: 'error',
          error: nodeError(Error, 'ERR_WORKER_UNSERIALIZABLE_ERROR', 'Serializing an uncaught exception failed'),
        });
      }
    },
    /** How many messages the parent port has sent, for 'bye'. */
    sentBy(fn) {
      sent = fn;
    },
  };
}

export function createWorkerThreads({ ctx, process, handles, ports, remote, getStream, Buffer, timers }) {
  const worker = workerDataOf(ctx);
  const environmentData = new Map(worker?.environmentData ?? []);
  // Thread ids: one counter for the program, shared with every thread.
  const ids = worker?.ids ?? (typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null);
  const threads = typeof ctx?.thread?.spawn === 'function';

  function workerPath(filename, isEval) {
    if (isEval) {
      if (typeof filename !== 'string') {
        throw ERR_INVALID_ARG_VALUE('options.eval', isEval, "must be false when 'filename' is not a string");
      }
      return { eval: filename };
    }
    if (filename !== null && typeof filename === 'object' && typeof filename.href === 'string') {
      if (filename.protocol === 'data:') return { url: filename.href };
      if (filename.protocol !== 'file:') {
        throw nodeError(TypeError, 'ERR_INVALID_URL_SCHEME', 'The URL must be of scheme data or file');
      }
      return { file: decodeURIComponent(filename.pathname) };
    }
    if (typeof filename !== 'string') throw ERR_INVALID_ARG_TYPE('filename', ['string', 'URL'], filename);
    if (filename.startsWith('/') || filename.startsWith('./') || filename.startsWith('../')) {
      return { file: process._builtin('path').resolve(filename) };
    }
    // data: and file:// come only as a URL object; a string of one is refused, as in Node.
    const hint = filename.startsWith('file://') ? ' Wrap file:// URLs with `new URL`.' : filename.startsWith('data:') ? ' Wrap data: URLs with `new URL`.' : '';
    throw nodeError(
      TypeError,
      'ERR_WORKER_PATH',
      `The worker script or module filename must be an absolute path or a relative path starting with './' or '../'.${hint} Received "${filename}"`
    );
  }

  function limitsOf(resourceLimits) {
    const limits = { ...DEFAULT_LIMITS };
    if (resourceLimits === undefined) return limits;
    validateObject(resourceLimits, 'options.resourceLimits');
    for (const key of LIMIT_KEYS) {
      const value = resourceLimits[key];
      // (Node takes what is a positive number, and leaves the rest.)
      if (typeof value === 'number' && value > 0) limits[key] = value;
    }
    return limits;
  }

  class Worker extends EventEmitter {
    #thread = null;
    #exited = false;
    #terminated = false;
    #exitCode;
    #exitWaiters = [];
    #pending = [];
    #limits;
    #handle = { kind: 'Worker' };
    #box;
    // The parent port's native port (its peer goes to the thread).
    #native;
    #name = '';
    #threadId;
    // Its 'exit' has been emitted: threadId is -1 from then on, as Node's.
    #exitEmitted = false;

    constructor(filename, options = {}) {
      super();
      if (!threads) {
        // (Older kernels, as before.)
        const err = new Error('slicc-jsh: worker_threads.Worker is not supported yet');
        err.code = 'ERR_NOT_SUPPORTED';
        throw err;
      }
      validateObject(options, 'options');
      const entry = workerPath(filename, !!options.eval);
      if (options.argv !== undefined && !Array.isArray(options.argv)) {
        throw ERR_INVALID_ARG_TYPE('options.argv', 'Array', options.argv);
      }
      if (options.execArgv !== undefined && !Array.isArray(options.execArgv)) {
        throw ERR_INVALID_ARG_TYPE('options.execArgv', 'Array', options.execArgv);
      }
      // As the thread will get them: strings (Node coerces them).
      const execArgv = options.execArgv === undefined ? undefined : options.execArgv.map(String);
      if (execArgv !== undefined) {
        const invalid = workerExecArgvError(execArgv);
        if (invalid) throw nodeError(Error, 'ERR_WORKER_INVALID_EXEC_ARGV', `Initiated Worker with invalid execArgv flags: ${invalid}`);
      }
      let env;
      const shareEnv = options.env === SHARE_ENV;
      if (shareEnv || options.env === undefined || options.env === null) env = { ...process.env };
      else if (typeof options.env === 'object') env = Object.fromEntries(Object.entries(options.env).map(([k, v]) => [k, String(v)]));
      else throw ERR_INVALID_ARG_TYPE('options.env', ['object', 'undefined', 'null', 'worker_threads.SHARE_ENV'], options.env);
      // An env of its own: its NODE_OPTIONS are the worker's, checked now.
      const nodeOptionsGiven = !shareEnv && options.env !== undefined && options.env !== null;
      const badNodeOptions = nodeOptionsGiven ? workerNodeOptionsError(env.NODE_OPTIONS) : null;
      if (badNodeOptions) throw nodeError(Error, 'ERR_WORKER_INVALID_EXEC_ARGV', `Initiated Worker with invalid NODE_OPTIONS env variable: ${badNodeOptions}`);
      if (options.name !== undefined && typeof options.name !== 'string') {
        throw ERR_INVALID_ARG_TYPE('options.name', 'string', options.name);
      }
      this.#name = options.name ?? '';
      this.#limits = limitsOf(options.resourceLimits);
      this.#threadId = ids ? Atomics.add(ids, 0, 1) + 1 : 1;

      // The parent's end of the worker's port; its messages are the worker's 'message's.
      const publicPort = ports.makePort();
      this[kPublicPort] = publicPort;
      publicPort.on('message', (message) => this.emit('message', message));
      publicPort.on('messageerror', (err) => this.emit('messageerror', err));
      // Until the thread is there, its messages wait.
      publicPort._attachLink({
        post: (message, transfer) => this.#pending.push([remote.hold(message, transfer)]),
        close: () => {},
      });
      // (The port's own listener refs it; the Worker's handle is what holds the program.)
      publicPort.unref();

      const { Readable, Writable } = getStream();
      this.stdin = null;
      if (options.stdin) {
        this.stdin = new Writable({
          write: (chunk, encoding, cb) => {
            this.#post({ t: 'in', chunk: new Uint8Array(chunk) });
            cb();
          },
          final: (cb) => {
            this.#post({ t: 'in-end' });
            cb();
          },
        });
      }
      this.stdout = new Readable({ read() {} });
      this.stderr = new Readable({ read() {} });
      if (!options.stdout) this.stdout.on('data', (chunk) => process.stdout.write(chunk));
      if (!options.stderr) this.stderr.on('data', (chunk) => process.stderr.write(chunk));

      // The parent port's mailboxes (../web/mailbox.mjs), one per direction.
      const [here, there] = remote.mailboxPair(1 << 20);
      this.#box = here;
      const channel = new remote.NativeMessageChannel();
      this.#native = channel.port1;
      const data = {
        mailbox: there,
        port: channel.port2,
        kind: WORKER_KIND,
        ...entry,
        argv: (options.argv ?? []).map(String),
        execArgv: execArgv ?? process.execArgv,
        env,
        // Else the parent's own (as it started), as Node's worker inherits them.
        nodeOptions: nodeOptionsGiven ? env.NODE_OPTIONS : worker ? worker.nodeOptions : ctx?.env?.NODE_OPTIONS,
        nodeOptionsGiven,
        shareEnv,
        cwd: process.cwd(),
        threadId: this.#threadId,
        name: options.name ?? '',
        stdin: !!options.stdin,
        resourceLimits: this.#limits,
        // Cloned now, as Node's constructor does: what can't be is its DataCloneError.
        environmentData: structuredClone([...environmentData]),
        ids,
      };
      // workerData and its transferList go as a port's message does. One
      // that can't (a DataCloneError) leaves no Worker, nor its handle.
      // The handle once nothing before it can throw: on a throw it goes too.
      handles.add(this.#handle);
      try {
        remote.pack(options.workerData, options.transferList, (packed, transfer) => {
          // As Node, which clones it in the constructor: what can't be
          // cloned (a function) is V8's DataCloneError now, not the
          // thread's start failing later, and its getters run once. The
          // thread gets this clone, its transfer list (buffers, streams,
          // ports) moved into it (the program's are detached, as in Node).
          const cloned = structuredClone({ packed, transfer }, { transfer });
          data.workerData = cloned.packed;
          this.#spawn(data, [channel.port2, ...cloned.transfer]);
        });
      } catch (err) {
        handles.delete(this.#handle);
        channel.port1.close();
        throw err;
      }
    }

    #spawn(data, transfer) {
      let spawning;
      // The kernel makes its channels as spawn starts, with the global
      // MessageChannel: the platform's, not the program's (jsh's).
      const desc = Object.getOwnPropertyDescriptor(globalThis, 'MessageChannel');
      const swap = desc && (desc.writable || desc.configurable) && desc.value !== remote.NativeMessageChannel;
      if (swap) globalThis.MessageChannel = remote.NativeMessageChannel;
      try {
        spawning = ctx.thread.spawn({ data, transfer });
      } catch (err) {
        spawning = Promise.reject(err);
      } finally {
        if (swap) globalThis.MessageChannel = desc.value;
      }
      spawning.then(
        (thread) => this.#started(thread),
        (err) => {
          const error = nodeError(Error, 'ERR_WORKER_INIT_FAILED', `Worker initialization failure: ${err?.message ?? err}`);
          process.nextTick(() => {
            // Ended even when nothing listens for 'error' (the emit throws).
            try {
              this.emit('error', error);
            } finally {
              this.#end(1);
            }
          });
        }
      );
    }

    #started(thread) {
      this.#thread = thread;
      let said;
      const linked = remote.link(this[kPublicPort], this.#native, undefined, this.#box);
      thread.port.onmessage = ({ data: message }) => {
        if (message?.t === 'online') this.emit('online');
        else if (message?.t === 'out') (message.fd === 2 ? this.stderr : this.stdout).push(Buffer.from(message.chunk));
        else if (message?.t === 'error') this.emit('error', message.error);
        else if (message?.t === 'bye') {
          said = message.code;
          // Once whatever its parent port posted before is in.
          linked.whenReceived(message.sent, () => this.#end(said));
        }
      };
      thread.exited.then((code) => {
        if (said !== undefined) return;
        // The thread ended without a word: terminate() (1), out of memory or a crash.
        // (The worker ends even when nothing listens for 'error'.)
        if (code === ctx.thread.NO_MEMORY) {
          try {
            this.emit('error', nodeError(Error, 'ERR_WORKER_OUT_OF_MEMORY', 'Worker terminated due to reaching memory limit: JS heap out of memory'));
          } finally {
            this.#end(1);
          }
        } else if (code === ctx.thread.CRASHED) {
          // Below the program (the kernel prints nothing): Node has no such
          // end, so the error is jsh's own. A thread ending as terminate()
          // asked is no error.
          try {
            if (!this.#terminated) this.emit('error', nodeError(Error, 'ERR_WORKER_CRASHED', "slicc-jsh: the worker's thread crashed"));
          } finally {
            this.#end(1);
          }
        } else this.#end(code);
      });
      // What was posted before the thread was there, now, with the exit
      // handler in place first: one that can't be sent is the program's
      // uncaught error, and the Worker still ends.
      for (const [held, own] of this.#pending.splice(0)) {
        try {
          if (own) thread.port.postMessage(own);
          else linked.postPacked(...held);
        } catch (err) {
          queueMicrotask(() => {
            throw err;
          });
        }
      }
    }

    #post(message) {
      if (this.#thread) this.#thread.port.postMessage(message);
      else this.#pending.push([null, message]);
    }

    #end(code) {
      if (this.#exited) return;
      this.#exited = true;
      this.#exitCode = code;
      this.stdout.push(null);
      this.stderr.push(null);
      this[kPublicPort]._remoteClosed();
      handles.delete(this.#handle);
      // After the last of the worker's messages and output, on jsh's own
      // timers (not the program's setImmediate, or require('timers')'s,
      // which it may replace). Messages its port still holds (they came
      // with its end) are dispatched first, a turn at a time: while their
      // count falls. A port that stops delivering (three turns without one)
      // doesn't hold the 'exit' back.
      let last = Infinity;
      let still = 0;
      const exit = () => {
        const pending = this[kPublicPort]._pending();
        if (pending > 0) {
          still = pending < last ? 0 : still + 1;
          last = pending;
          if (still < 3) {
            timers.setImmediate(exit);
            return;
          }
        }
        this.#exitEmitted = true;
        this.emit('exit', code);
        for (const resolve of this.#exitWaiters.splice(0)) resolve(code);
      };
      timers.setImmediate(exit);
    }

    postMessage(message, transfer) {
      if (arguments.length === 0) {
        throw nodeError(TypeError, 'ERR_MISSING_ARGS', 'The "value" argument must be specified');
      }
      if (this.#exited) return;
      this[kPublicPort].postMessage(message, transfer);
    }

    terminate(callback) {
      if (typeof callback === 'function') {
        process.emitWarning('Passing a callback to worker.terminate() is deprecated. It returns a Promise instead.', 'DeprecationWarning', 'DEP0132');
        this.once('exit', (code) => callback(null, code));
      }
      // Once it has exited: undefined, as Node's.
      if (this.#exited) return Promise.resolve(undefined);
      this.#terminated = true;
      const done = new Promise((resolve) => this.#exitWaiters.push(resolve));
      if (this.#thread) this.#thread.terminate().catch(() => {});
      else this.once('online', () => this.#thread?.terminate().catch(() => {}));
      return done;
    }

    ref() {
      if (!this.#exited) handles.add(this.#handle);
    }

    unref() {
      handles.delete(this.#handle);
    }

    get resourceLimits() {
      return this.#exited ? {} : { ...this.#limits };
    }

    // -1 from its 'exit' on (its last messages still see its id), as Node's.
    get threadId() {
      return this.#exitEmitted ? -1 : this.#threadId;
    }

    get threadName() {
      return this.#exited ? null : this.#name;
    }

    get performance() {
      return { eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }) };
    }

    getHeapSnapshot() {
      return Promise.reject(nodeError(Error, 'ERR_NOT_SUPPORTED', 'slicc-jsh: worker.getHeapSnapshot is not supported'));
    }

    [Symbol.asyncDispose]() {
      return this.terminate();
    }
  }

  // A worker's parentPort: its jsh port, on its own native port.
  let parentPort = null;
  if (worker) {
    parentPort = ports.makePort();
    const linked = remote.link(parentPort, worker.port, undefined, worker.mailbox);
    process._worker.sentBy(() => linked.sent);
  }
  const workerData = worker ? remote.receive(worker.workerData).data : null;

  const module = {
    isInternalThread: false,
    isMainThread: !worker,
    MessagePort: ports?.MessagePort ?? globalThis.MessagePort,
    MessageChannel: ports?.MessageChannel ?? globalThis.MessageChannel,
    markAsUncloneable: () => {},
    markAsUntransferable: () => {},
    isMarkedAsUntransferable: () => false,
    moveMessagePortToContext: (port) => port,
    receiveMessageOnPort: (port) => ports?.receiveMessageOnPort(port),
    resourceLimits: worker ? { ...worker.resourceLimits } : {},
    postMessageToThread: async () => {
      throw Object.assign(new Error('slicc-jsh: worker_threads.postMessageToThread is not supported yet'), { code: 'ERR_NOT_SUPPORTED' });
    },
    threadId: worker ? worker.threadId : 0,
    threadName: worker ? worker.name : '',
    SHARE_ENV,
    Worker,
    parentPort,
    workerData,
    BroadcastChannel: process._broadcastChannel,
    setEnvironmentData(key, value) {
      if (value === undefined) environmentData.delete(key);
      else environmentData.set(key, value);
    },
    getEnvironmentData: (key) => environmentData.get(key),
  };
  return module;
}
