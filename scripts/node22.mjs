/**
 * The host Node 22.22.0 the baselines run on (goldens, jsh parity, cert,
 * compare). $NODE22 names it when it is installed already (CI: setup-node);
 * otherwise `npx -y node@22.22.0` fetches it once, and its binary is run
 * directly from then on. Resolving it is bounded, so a stalled fetch fails
 * the run with a message instead of hanging it.
 */
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';

export const NODE22_VERSION = '22.22.0';
const RESOLVE_TIMEOUT_MS = 180_000;

let bin;

export function node22Bin() {
  if (bin) return bin;
  const fromEnv = process.env.NODE22;
  if (fromEnv) {
    const v = spawnSync(fromEnv, ['--version'], { encoding: 'utf8', timeout: 30_000 });
    if (v.status !== 0 || v.stdout.trim() !== `v${NODE22_VERSION}`) {
      throw new Error(`$NODE22 (${fromEnv}) is not Node ${NODE22_VERSION}: ${v.error?.message ?? v.stdout.trim()}`);
    }
    bin = fromEnv;
    return bin;
  }
  const r = spawnSync('npx', ['-y', `node@${NODE22_VERSION}`, '-p', 'process.execPath'], {
    encoding: 'utf8',
    env: { ...process.env, npm_config_yes: 'true' },
    timeout: RESOLVE_TIMEOUT_MS,
    // A stalled fetch can leave a grandchild holding the pipe: don't wait for it.
    killSignal: 'SIGKILL',
  });
  if (r.error || r.status !== 0) {
    throw new Error(`cannot get node@${NODE22_VERSION} with npx: ${r.error?.message ?? r.stderr}`);
  }
  bin = r.stdout.trim();
  return bin;
}

/**
 * An environment for a baseline run: `env` with Node 22's directory first on
 * PATH, so a fixture that runs `node` (a child process) gets Node 22 too, as
 * under npx (which puts the fetched package's bin first).
 */
export function node22Env(env = process.env) {
  const dir = dirname(node22Bin());
  const sep = process.platform === 'win32' ? ';' : ':';
  return { ...env, PATH: [dir, env.PATH ?? ''].filter(Boolean).join(sep) };
}
