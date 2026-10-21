/**
 * `sliccy:exec` and `sliccy:skill`, over the engine's `spawn`.
 *
 * `exec(cmd)` runs `cmd` through the engine's shell (`bash -c` when the host
 * has bash, `sh -c` otherwise; the kernel's `sh` is bash). `exec.spawn(argv)`
 * runs argv with no shell. `exec.start()` is the killable, buffered-stdin form
 * of slicc v6 (`realm-exec-bridge.ts`). Results are `{ stdout, stderr,
 * exitCode }` with UTF-8 strings; a command that does not exist gives 127.
 */

const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

export function killExitCode(sig = 'SIGTERM') {
  const n = typeof sig === 'number' ? sig : (SIGNALS[sig] ?? 15);
  return 128 + n;
}

export function createExec(engine) {
  const shellArgv = (command, args = []) => [...engine.shell, command, 'jsh', ...args];

  const run = (argv, stdin) => engine.spawn(argv, { stdin }).done;

  const exec = (command) => {
    if (typeof command !== 'string') throw new TypeError('exec(command): command must be a string');
    return run(shellArgv(command));
  };

  exec.spawn = (argv) => {
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new TypeError('exec.spawn(argv): argv must be a non-empty array');
    }
    return run(argv.map(String));
  };

  exec.start = (commandOrArgv, opts = {}) => {
    const argv = Array.isArray(commandOrArgv)
      ? [...commandOrArgv.map(String), ...(opts.args ?? []).map(String)]
      : shellArgv(String(commandOrArgv), (opts.args ?? []).map(String));
    const chunks = [];
    let child = null;
    let killed = false;
    let resolveDone;
    let rejectDone;
    const done = new Promise((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const fire = () => {
      if (child || killed) return;
      const stdin = chunks.length > 0 ? chunks.join('') : opts.stdin;
      child = engine.spawn(argv, { stdin });
      child.done.then(resolveDone, rejectDone);
    };
    return {
      kill(sig) {
        if (child) return Promise.resolve(child.kill(sig ?? 'SIGTERM')).then(() => true);
        killed = true;
        resolveDone({ stdout: '', stderr: '', exitCode: killExitCode(sig) });
        return Promise.resolve(true);
      },
      stdin: {
        write(chunk) {
          if (!child && !killed) chunks.push(String(chunk));
        },
        end: () => fire(),
      },
      done,
    };
  };

  exec.exec = exec;
  return exec;
}

function dirnameOf(path) {
  if (!path) return '';
  const idx = path.lastIndexOf('/');
  if (idx < 0) return '';
  if (idx === 0) return '/';
  return path.slice(0, idx);
}

function joinChild(dir, name) {
  if (dir === '') return name;
  if (dir === '/') return `/${name}`;
  return `${dir}/${name}`;
}

/**
 * `sliccy:skill`, ported from slicc's `skill-global.ts`. `fs` is the
 * engine's Node `fs`; `token(id)` runs `jerk <id> get --reveal` and nothing
 * else (slicc-jsh#74; it ran v6's `oauth-token` before). The id goes to jerk
 * as it is: jerk's provider ids are canonical, with no aliases.
 */
/**
 * The skill folder for the Agent Skills layout, as in slicc v6
 * (`skill-global.ts`): for a script under a `scripts` directory
 * (`<skill>/scripts/<name>.jsh`, or a helper nested below it) it is that
 * directory's parent; otherwise the script's own directory (a `.jsh` next
 * to SKILL.md). v6 takes the first `scripts` segment of the path; this takes
 * the last, so a host path such as `~/scripts/<skill>/scripts/x.jsh` still
 * finds `<skill>`. The two agree for every skill path v6 has.
 */
export function skillRootOf(dir) {
  if (!dir) return dir;
  const absolute = dir.startsWith('/');
  const parts = dir.split('/').filter(Boolean);
  const at = parts.lastIndexOf('scripts');
  if (at < 0) return dir;
  const rootParts = parts.slice(0, at);
  if (rootParts.length === 0) return absolute ? '/' : '';
  return (absolute ? '/' : '') + rootParts.join('/');
}

export function createSkill({ argv, fs, exec }) {
  const dir = dirnameOf(argv[1] ?? '');
  const root = skillRootOf(dir);
  const refs = joinChild(root, 'references');
  const assets = joinChild(root, 'assets');
  const configPath = joinChild(dir, '.config');

  async function readConfig() {
    let text;
    try {
      if (!fs.existsSync(configPath)) return null;
      text = await fs.promises.readFile(configPath, 'utf8');
    } catch {
      return null;
    }
    if (!String(text).trim()) return null;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`skill.config(): failed to parse ${configPath}: ${err?.message ?? err}`);
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    throw new Error(`skill.config(): ${configPath} must contain a JSON object`);
  }

  async function config(updates) {
    const existing = await readConfig();
    if (updates === undefined) return existing;
    if (updates === null || typeof updates !== 'object' || Array.isArray(updates)) {
      throw new TypeError('skill.config(updates): updates must be a plain object');
    }
    const merged = { ...(existing ?? {}), ...updates };
    await fs.promises.writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`);
    return merged;
  }

  /**
   * `params` is a bag of jerk provider parameters: `{ org: 'adobe' }` is
   * `-p org=adobe`, in the bag's order. A value is a string, number or
   * boolean; an `undefined` one is left out, so an unset option can pass
   * straight through. jerk refuses a parameter its provider doesn't have.
   */
  async function token(providerId, params) {
    if (typeof providerId !== 'string' || !providerId.trim()) {
      throw new TypeError('skill.token(providerId): providerId must be a non-empty string');
    }
    const argv = ['jerk', providerId, 'get', '--reveal'];
    if (params !== undefined) {
      if (params === null || typeof params !== 'object' || Array.isArray(params)) {
        throw new TypeError('skill.token(providerId, params): params must be a plain object');
      }
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined) continue;
        if (!key || key.includes('=')) {
          throw new TypeError(`skill.token(providerId, params): bad parameter name ${JSON.stringify(key)}`);
        }
        if (!['string', 'number', 'boolean'].includes(typeof value)) {
          throw new TypeError(`skill.token(providerId, params): ${key} must be a string, number or boolean`);
        }
        argv.push('-p', `${key}=${value}`);
      }
    }
    const { stdout, stderr, exitCode } = await exec.spawn(argv);
    if (exitCode !== 0) {
      const msg = stderr.trim() || `jerk exited with code ${exitCode}`;
      const err = new Error(`skill.token('${providerId}'): ${msg}`);
      err.exitCode = exitCode;
      throw err;
    }
    return stdout.replace(/\r?\n+$/, '');
  }

  return Object.freeze({ dir, root, refs, assets, config, token });
}
