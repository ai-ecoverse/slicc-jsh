/**
 * node:cluster — Node 22.22.0's (lib/internal/cluster/primary.js, child.js,
 * worker.js and utils.js): the primary forks workers (child_process.fork
 * with NODE_UNIQUE_ID), and they talk over the IPC channel in internal
 * NODE_CLUSTER messages, with Node's events and states ('fork', 'online',
 * 'listening', 'message', 'disconnect', 'exit').
 *
 * A worker's server: in Node the primary listens and hands each connection
 * (round robin) or the listening socket to a worker, as a handle over the
 * IPC channel. The kernel can't pass a descriptor between processes, so here
 * the worker listens on a loopback port of its own, which it tells the
 * primary (queryServer's `proxy`); the primary listens where the worker
 * asked and joins each connection it accepts to the next worker's port. The
 * worker's server says the primary's address. What differs from Node: the
 * worker's socket sees the primary as its peer, and SCHED_NONE is round
 * robin too.
 *
 * Without fork (a kernel with no IPC channel), cluster is the primary that
 * can't fork: cluster.fork throws ERR_NOT_SUPPORTED, as before.
 */
import { EventEmitter } from './events.mjs';

const SCHED_NONE = 1;
const SCHED_RR = 2;

function notSupported(what) {
  const err = new Error(`slicc-jsh: '${what}' is not supported yet (child_process.fork has no IPC channel)`);
  err.code = 'ERR_NOT_SUPPORTED';
  return err;
}

/** internal/cluster/utils.js: internal messages, with acks. */
function createMessaging() {
  const callbacks = new Map();
  let seq = 0;
  function sendHelper(proc, message, handle, cb) {
    if (!proc.connected) return false;
    message = { cmd: 'NODE_CLUSTER', ...message, seq };
    if (typeof cb === 'function') callbacks.set(seq, cb);
    seq += 1;
    return proc.send(message, handle);
  }
  function internal(worker, cb) {
    return function onInternalMessage(message, handle) {
      if (message.cmd !== 'NODE_CLUSTER') return;
      let fn = cb;
      if (message.ack !== undefined) {
        const callback = callbacks.get(message.ack);
        if (callback !== undefined) {
          fn = callback;
          callbacks.delete(message.ack);
        }
      }
      Reflect.apply(fn, worker, arguments);
    };
  }
  return { sendHelper, internal };
}

/** internal/cluster/worker.js: the Worker both sides share. */
function createWorkerClass() {
  function Worker(options) {
    if (!(this instanceof Worker)) return new Worker(options);
    Reflect.apply(EventEmitter, this, []);
    if (options === null || typeof options !== 'object') options = {};
    this.exitedAfterDisconnect = undefined;
    this.state = options.state || 'none';
    this.id = options.id | 0;
    if (options.process) {
      this.process = options.process;
      this.process.on('error', (code, signal) => this.emit('error', code, signal));
      this.process.on('message', (message, handle) => this.emit('message', message, handle));
    }
  }
  Object.setPrototypeOf(Worker.prototype, EventEmitter.prototype);
  Object.setPrototypeOf(Worker, EventEmitter);
  Worker.prototype.kill = function () {
    Reflect.apply(this.destroy, this, arguments);
  };
  Worker.prototype.send = function () {
    return Reflect.apply(this.process.send, this.process, arguments);
  };
  Worker.prototype.isDead = function () {
    return this.process.exitCode != null || this.process.signalCode != null;
  };
  Worker.prototype.isConnected = function () {
    return this.process.connected;
  };
  return Worker;
}

export function createCluster({ process, getChildProcess, getNet, canFork = () => false }) {
  if (process?.env && 'NODE_UNIQUE_ID' in process.env && typeof process.send === 'function') {
    return createChild({ process });
  }
  return createPrimary({ process, getChildProcess, getNet, canFork });
}

function createPrimary({ process, getChildProcess, getNet, canFork }) {
  const Worker = createWorkerClass();
  const { sendHelper, internal } = createMessaging();
  const cluster = new EventEmitter();
  const intercom = new EventEmitter();
  const handles = new Map();
  cluster.isWorker = false;
  cluster.isMaster = true;
  cluster.isPrimary = true;
  cluster.Worker = Worker;
  cluster.workers = {};
  cluster.settings = {};
  cluster.SCHED_NONE = SCHED_NONE;
  cluster.SCHED_RR = SCHED_RR;
  const policy = process?.env?.NODE_CLUSTER_SCHED_POLICY;
  cluster.schedulingPolicy = policy === 'none' ? SCHED_NONE : SCHED_RR;

  let ids = 0;
  let initialized = false;
  const setupSettingsNT = (settings) => cluster.emit('setup', settings);
  cluster.setupPrimary = function (options) {
    const settings = {
      args: (process?.argv ?? []).slice(2),
      exec: process?.argv?.[1],
      execArgv: process?.execArgv ?? [],
      silent: false,
      ...cluster.settings,
      ...options,
    };
    if (
      settings.execArgv.some((s) => s.startsWith('--prof')) &&
      !settings.execArgv.some((s) => s.startsWith('--logfile='))
    ) {
      settings.execArgv = [...settings.execArgv, '--logfile=v8-%p.log'];
    }
    cluster.settings = settings;
    if (initialized === true) return process.nextTick(setupSettingsNT, settings);
    initialized = true;
    process.nextTick(setupSettingsNT, settings);
    return undefined;
  };
  cluster.setupMaster = cluster.setupPrimary;

  function createWorkerProcess(id, env) {
    const workerEnv = { ...process.env, ...env, NODE_UNIQUE_ID: `${id}` };
    return getChildProcess().fork(cluster.settings.exec, cluster.settings.args, {
      cwd: cluster.settings.cwd,
      env: workerEnv,
      serialization: cluster.settings.serialization,
      silent: cluster.settings.silent,
      windowsHide: cluster.settings.windowsHide,
      execArgv: [...cluster.settings.execArgv],
      stdio: cluster.settings.stdio,
      gid: cluster.settings.gid,
      uid: cluster.settings.uid,
    });
  }

  function removeWorker(worker) {
    delete cluster.workers[worker.id];
    if (Object.keys(cluster.workers).length === 0) intercom.emit('disconnect');
  }

  function removeHandlesForWorker(worker) {
    for (const [key, handle] of handles) {
      if (handle.remove(worker)) handles.delete(key);
    }
  }

  cluster.fork = function (env) {
    cluster.setupPrimary();
    if (!canFork()) throw notSupported('cluster.fork');
    const id = ++ids;
    const workerProcess = createWorkerProcess(id, env);
    const worker = new Worker({ id, process: workerProcess });
    worker.on('message', function (message, handle) {
      cluster.emit('message', this, message, handle);
    });
    worker.process.once('exit', (exitCode, signalCode) => {
      // Gone from the list once it has also disconnected.
      if (!worker.isConnected()) {
        removeHandlesForWorker(worker);
        removeWorker(worker);
      }
      worker.exitedAfterDisconnect = !!worker.exitedAfterDisconnect;
      worker.state = 'dead';
      worker.emit('exit', exitCode, signalCode);
      cluster.emit('exit', worker, exitCode, signalCode);
    });
    worker.process.once('disconnect', () => {
      removeHandlesForWorker(worker);
      if (worker.isDead()) removeWorker(worker);
      worker.exitedAfterDisconnect = !!worker.exitedAfterDisconnect;
      worker.state = 'disconnected';
      worker.emit('disconnect');
      cluster.emit('disconnect', worker);
    });
    worker.process.on('internalMessage', internal(worker, onmessage));
    process.nextTick(() => cluster.emit('fork', worker));
    cluster.workers[worker.id] = worker;
    return worker;
  };

  cluster.disconnect = function (cb) {
    const workers = Object.values(cluster.workers);
    if (workers.length === 0) process.nextTick(() => intercom.emit('disconnect'));
    else for (const worker of workers) if (worker.isConnected()) worker.disconnect();
    if (typeof cb === 'function') intercom.once('disconnect', cb);
  };

  const methods = { close, exitedAfterDisconnect, listening, online, queryServer };
  function onmessage(message) {
    const fn = methods[message.act];
    if (typeof fn === 'function') fn(this, message);
  }

  function online(worker) {
    worker.state = 'online';
    worker.emit('online');
    cluster.emit('online', worker);
  }

  function exitedAfterDisconnect(worker, message) {
    worker.exitedAfterDisconnect = true;
    send(worker, { ack: message.seq });
  }

  function queryServer(worker, message) {
    if (worker.exitedAfterDisconnect) return;
    const key = `${message.address}:${message.port}:${message.addressType}:${message.fd}:${message.index}`;
    let handle = handles.get(key);
    if (handle === undefined) {
      handle = proxyHandle(key, message);
      handles.set(key, handle);
    }
    handle.data ||= message.data;
    handle.add(worker, message.proxy, (errno, reply) => {
      // A worker that has asked to leave (acknowledged) doesn't wait for
      // the answer, and may be gone, its end closed, before this side has
      // read that: the write would be an EPIPE (#675). Node's primary
      // answers before it acks, its bind being synchronous.
      const { data } = handles.get(key) ?? handle;
      // A bind that failed isn't kept, whoever asked for it.
      if (errno) handles.delete(key);
      if (worker.exitedAfterDisconnect) return;
      send(worker, { errno, key, ack: message.seq, data, ...reply });
    });
  }

  /**
   * The primary's listener for one key: it accepts, and joins each
   * connection to the next worker's own loopback port (Node's
   * RoundRobinHandle hands the socket itself over).
   */
  function proxyHandle(key, message) {
    const net = getNet();
    const workers = [];
    // Workers whose add() waits for the bind: one removed meanwhile is never added.
    const pending = new Set();
    let next = 0;
    let state = 'listening';
    let failure;
    const waiting = [];
    const server = net.createServer((socket) => {
      const live = workers.filter(({ worker }) => worker.isConnected());
      if (live.length === 0) {
        socket.destroy();
        return;
      }
      const { port } = live[next++ % live.length];
      const upstream = net.connect({ port, host: '127.0.0.1' });
      const end = () => {
        socket.destroy();
        upstream.destroy();
      };
      socket.on('error', end);
      upstream.on('error', end);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    server.on('error', (err) => {
      state = 'failed';
      failure = err;
      for (const done of waiting.splice(0)) done();
    });
    server.listen({ host: message.address ?? undefined, port: message.port > 0 ? message.port : 0 }, () => {
      state = 'ready';
      for (const done of waiting.splice(0)) done();
    });
    return {
      data: null,
      add(worker, proxy, cb) {
        pending.add(worker);
        const settle = () => {
          if (!pending.delete(worker)) return;
          if (state === 'failed') return cb(failure?.code ?? 'EADDRINUSE', { message: failure?.message });
          workers.push({ worker, port: proxy?.port });
          const address = server.address();
          return cb(0, { sockname: address });
        };
        if (state === 'listening') waiting.push(settle);
        else settle();
      },
      remove(worker) {
        const waited = pending.delete(worker);
        const before = workers.length;
        for (let i = workers.length - 1; i >= 0; i--) if (workers[i].worker === worker) workers.splice(i, 1);
        if (!waited && workers.length === before) return false;
        if (workers.length > 0 || pending.size > 0) return false;
        server.close();
        return true;
      },
    };
  }

  function listening(worker, message) {
    const info = { addressType: message.addressType, address: message.address, port: message.port, fd: message.fd };
    worker.state = 'listening';
    worker.emit('listening', info);
    cluster.emit('listening', worker, info);
  }

  function close(worker, message) {
    const handle = handles.get(message.key);
    if (handle && handle.remove(worker)) handles.delete(message.key);
  }

  function send(worker, message, handle, cb) {
    return sendHelper(worker.process, message, handle, cb);
  }

  Worker.prototype.disconnect = function () {
    this.exitedAfterDisconnect = true;
    send(this, { act: 'disconnect' });
    removeHandlesForWorker(this);
    removeWorker(this);
    return this;
  };
  Worker.prototype.destroy = function (signo) {
    this.process.kill(signo || 'SIGTERM');
  };

  return cluster;
}

function createChild({ process }) {
  const Worker = createWorkerClass();
  const { sendHelper, internal } = createMessaging();
  const cluster = new EventEmitter();
  const handles = new Map();
  const indexes = new Map();
  cluster.isWorker = true;
  cluster.isMaster = false;
  cluster.isPrimary = false;
  cluster.worker = null;
  cluster.Worker = Worker;
  // queryServer requests the primary hasn't answered: they end when the
  // channel does (net closes the server's own listener, which never listens).
  const queries = new Set();

  const send = (message, cb) => sendHelper(process, message, null, cb);

  cluster._setupWorker = function () {
    const worker = new Worker({ id: +process.env.NODE_UNIQUE_ID | 0, process, state: 'online' });
    cluster.worker = worker;
    process.once('disconnect', () => {
      for (const cancel of [...queries]) cancel();
      worker.emit('disconnect');
      // The primary went, or some such: the worker ends at once.
      if (!worker.exitedAfterDisconnect) process.exit(0);
    });
    process.on('internalMessage', internal(worker, onmessage));
    send({ act: 'online' });
    function onmessage(message) {
      if (message.act === 'disconnect') Reflect.apply(_disconnect, worker, [true]);
    }
  };

  /**
   * net's listen() in a worker (net.mjs): the server, listening on its own
   * loopback port (`proxy`), asks the primary for the address it wants.
   * Resolves with { errno, key, sockname }.
   */
  cluster._getServer = function (server, options) {
    const indexesKey = [options.address, options.port, options.addressType, options.fd].join(':');
    let indexSet = indexes.get(indexesKey);
    if (indexSet === undefined) {
      indexSet = { nextIndex: 0, set: new Set() };
      indexes.set(indexesKey, indexSet);
    }
    const index = indexSet.nextIndex++;
    indexSet.set.add(index);
    const message = { act: 'queryServer', index, data: null, ...options };
    return new Promise((resolve) => {
      const cancel = () => {
        queries.delete(cancel);
        removeIndexesKey(indexesKey, index);
        resolve({ cancelled: true });
      };
      queries.add(cancel);
      send(message, (reply) => {
        if (!queries.delete(cancel)) return;
        if (reply.errno) {
          removeIndexesKey(indexesKey, index);
          return resolve(reply);
        }
        handles.set(reply.key, {
          server,
          close: () => {
            send({ act: 'close', key: reply.key });
            handles.delete(reply.key);
            removeIndexesKey(indexesKey, index);
          },
        });
        server.once('listening', () => {
          if (!indexes.has(indexesKey)) return;
          cluster.worker.state = 'listening';
          const address = server.address();
          send({ ...message, act: 'listening', port: address?.port || options.port });
        });
        resolve(reply);
      });
      if (!process.connected) cancel();
    });
  };

  /** A worker's server closed (net.mjs). */
  cluster._closeServer = function (key) {
    handles.get(key)?.close();
  };

  function removeIndexesKey(indexesKey, index) {
    const indexSet = indexes.get(indexesKey);
    if (!indexSet) return;
    indexSet.set.delete(index);
    if (indexSet.set.size === 0) indexes.delete(indexesKey);
  }

  function _disconnect(primaryInitiated) {
    this.exitedAfterDisconnect = true;
    let waitingCount = 1;
    function checkWaitingCount() {
      waitingCount--;
      if (waitingCount === 0) {
        // Worker-initiated: wait for the primary's ack, so it knows.
        if (primaryInitiated) process.disconnect();
        else send({ act: 'exitedAfterDisconnect' }, () => process.disconnect());
      }
    }
    for (const handle of handles.values()) {
      waitingCount++;
      handle.server.close(checkWaitingCount);
    }
    handles.clear();
    checkWaitingCount();
  }

  Worker.prototype.disconnect = function () {
    if (this.state !== 'disconnecting' && this.state !== 'destroying') {
      this.state = 'disconnecting';
      Reflect.apply(_disconnect, this, []);
    }
    return this;
  };
  Worker.prototype.destroy = function () {
    if (this.state === 'destroying') return;
    this.exitedAfterDisconnect = true;
    if (!this.isConnected()) {
      process.exit(0);
    } else {
      this.state = 'destroying';
      send({ act: 'exitedAfterDisconnect' }, () => process.disconnect());
      process.once('disconnect', () => process.exit(0));
    }
  };

  return cluster;
}
