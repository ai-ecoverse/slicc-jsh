/**
 * node:cluster — Node 22.22.0's primary (lib/internal/cluster/primary.js
 * and worker.js), so a package that requires cluster at load runs as the
 * primary it is: isPrimary, workers, settings, setupPrimary and its 'setup'
 * event, disconnect, the Worker class. A worker would be a child_process.fork
 * with an IPC channel, which jsh doesn't have yet, so cluster.fork throws
 * ERR_NOT_SUPPORTED when it is called.
 */
import { EventEmitter } from './events.mjs';

const SCHED_NONE = 1;
const SCHED_RR = 2;

function notSupported(what) {
  const err = new Error(`slicc-jsh: '${what}' is not supported yet (child_process.fork has no IPC channel)`);
  err.code = 'ERR_NOT_SUPPORTED';
  return err;
}

export function createCluster({ process }) {
  // worker.js: the Worker both sides share, plus primary.js's methods.
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
  Worker.prototype.disconnect = function () {
    this.exitedAfterDisconnect = true;
    delete cluster.workers[this.id];
    return this;
  };
  Worker.prototype.destroy = function (signo) {
    this.process.kill(signo || 'SIGTERM');
  };

  const cluster = new EventEmitter();
  const intercom = new EventEmitter();
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

  cluster.fork = function (env) {
    void env;
    cluster.setupPrimary();
    throw notSupported('cluster.fork');
  };

  cluster.disconnect = function (cb) {
    const workers = Object.values(cluster.workers);
    if (workers.length === 0) process.nextTick(() => intercom.emit('disconnect'));
    else for (const worker of workers) if (worker.isConnected()) worker.disconnect();
    if (typeof cb === 'function') intercom.once('disconnect', cb);
  };
  return cluster;
}
