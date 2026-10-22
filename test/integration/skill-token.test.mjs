// sliccy:skill's token(id) on the host runs the real jerk (the
// @ai-ecoverse/slicc-jerk devDependency) as `jerk <id> get --reveal`
// (slicc-jsh#74). jerk reads a test providers.toml (SLICC_JERK_CONFIG) whose
// providers are backed by a fake CLI on PATH, with HOME, the user config and
// jerk's state in a temporary directory, so the machine's own sign-ins and
// providers never take part.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hostJsh = join(root, 'dist/host/jsh.mjs');
const jerkBin = join(root, 'node_modules/.bin');

const PROVIDERS = `
[providers.jsh-fake]
name = "slicc-jsh fake"
env = ["JSH_FAKE_TOKEN"]
requires = "jsh-fake-auth"
get = { run = ["jsh-fake-auth", "token"], parse = "text" }
create = { run = ["jsh-fake-auth", "login"], interactive = true }

[providers.jsh-fake-out]
name = "slicc-jsh fake, signed out"
env = ["JSH_FAKE_OUT_TOKEN"]
requires = "jsh-fake-auth"
get = { run = ["jsh-fake-auth", "signed-out"], parse = "text" }
create = { run = ["jsh-fake-auth", "login"], interactive = true }

[providers.jsh-fake-params]
name = "slicc-jsh fake, with params"
env = ["JSH_FAKE_PARAMS_TOKEN"]
requires = "jsh-fake-auth"
params = { org = "", site = "main" }
get = { run = ["jsh-fake-auth", "token", "--org", "{org}", "--site", "{site}"], parse = "text" }

[providers.jsh-fake-missing]
name = "slicc-jsh fake, CLI missing"
env = ["JSH_FAKE_MISSING_TOKEN"]
requires = "jsh-not-installed"
get = { run = ["jsh-not-installed", "token"], parse = "text" }
`;

// Records each call, one argument per line, so the test sees what jerk asked of the CLI.
const FAKE_AUTH = `#!/bin/sh
printf '%s\\n' "$@" >> "$JSH_FAKE_LOG"
case "$1" in
  token) printf 'fake-token-123\\n' ;;
  signed-out) echo 'jsh-fake-auth: not signed in' >&2; exit 1 ;;
  *) exit 2 ;;
esac
`;

// Each argument is a provider id, or JSON \`[id, params]\`.
const SCRIPT = `const skill = require('sliccy:skill');
for (const arg of process.argv.slice(2)) {
  const [id, params] = arg.startsWith('[') ? JSON.parse(arg) : [arg];
  try {
    console.log(JSON.stringify({ id, token: await skill.token(id, params) }));
  } catch (err) {
    console.log(JSON.stringify({ id, message: err.message, exitCode: err.exitCode }));
  }
}
`;

describe('skill.token over jerk (host)', { skip: process.platform === 'win32' }, () => {
  let dir;
  let log;
  let env;

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'jsh-jerk-')));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'jsh-fake-auth'), FAKE_AUTH, { mode: 0o755 });
    writeFileSync(join(dir, 'providers.toml'), PROVIDERS);
    writeFileSync(join(dir, 'token.jsh'), SCRIPT);
    log = join(dir, 'calls.log');
    env = {
      PATH: [bin, jerkBin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
      HOME: join(dir, 'home'),
      XDG_CONFIG_HOME: join(dir, 'config'),
      SLICC_JERK_CONFIG: join(dir, 'providers.toml'),
      SLICC_JERK_STATE_DIR: join(dir, 'state'),
      SLICC_JERK_STORE: 'file',
      JSH_FAKE_LOG: log,
    };
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  const run = (ids, extraEnv = {}) => {
    writeFileSync(log, '');
    const r = spawnSync(process.execPath, [hostJsh, 'token.jsh', ...ids], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...env, ...extraEnv },
    });
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    return r.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  };

  it("returns the provider's token without the newline", () => {
    assert.deepEqual(run(['jsh-fake']), [{ id: 'jsh-fake', token: 'fake-token-123' }]);
    assert.equal(readFileSync(log, 'utf8'), 'token\n');
  });

  it('passes a params bag as -p key=value, in order', () => {
    const call = (params) => JSON.stringify(['jsh-fake-params', params]);
    assert.deepEqual(run([call({ org: 'adobe', site: 'www' })]), [{ id: 'jsh-fake-params', token: 'fake-token-123' }]);
    assert.equal(readFileSync(log, 'utf8'), 'token\n--org\nadobe\n--site\nwww\n');
    // No bag: jerk's defaults, and an empty param drops its flag.
    assert.deepEqual(run(['jsh-fake-params']), [{ id: 'jsh-fake-params', token: 'fake-token-123' }]);
    assert.equal(readFileSync(log, 'utf8'), 'token\n--site\nmain\n');
    // One argument each, with no shell in between.
    assert.deepEqual(run([call({ org: 'a b=c;$(x)', site: 7 })]), [{ id: 'jsh-fake-params', token: 'fake-token-123' }]);
    assert.equal(readFileSync(log, 'utf8'), 'token\n--org\na b=c;$(x)\n--site\n7\n');
  });

  it('refuses a bad params bag, and jerk refuses a parameter its provider lacks', () => {
    assert.deepEqual(run([JSON.stringify(['jsh-fake-params', ['org']]), JSON.stringify(['jsh-fake-params', { nope: 1 }])]), [
      { id: 'jsh-fake-params', message: 'skill.token(providerId, params): params must be a plain object' },
      {
        id: 'jsh-fake-params',
        message: "skill.token('jsh-fake-params'): jerk: jsh-fake-params has no param nope\nRun jerk --help for usage.",
        exitCode: 2,
      },
    ]);
    assert.equal(readFileSync(log, 'utf8'), '');
  });

  it("returns the token from the provider's env variable first, as jerk does", () => {
    assert.deepEqual(run(['jsh-fake'], { JSH_FAKE_TOKEN: 'from-env' }), [{ id: 'jsh-fake', token: 'from-env' }]);
    assert.equal(readFileSync(log, 'utf8'), '');
  });

  it("throws jerk's stderr with its exit code: sign in (3), not here (4), unknown (2)", () => {
    assert.deepEqual(run(['jsh-fake-out', 'jsh-fake-missing', 'adobe']), [
      {
        id: 'jsh-fake-out',
        message:
          "skill.token('jsh-fake-out'): jerk: jsh-fake-out: jsh-fake-auth get exited 1\n" +
          'jerk: jsh-fake-out: sign in with jerk jsh-fake-out create',
        exitCode: 3,
      },
      {
        id: 'jsh-fake-missing',
        message: "skill.token('jsh-fake-missing'): jerk: jsh-fake-missing: jsh-not-installed is not on PATH; install it first",
        exitCode: 4,
      },
      {
        id: 'adobe',
        message:
          "skill.token('adobe'): jerk: unknown provider adobe; jerk list shows the configured ones\n" +
          'Run jerk --help for usage.',
        exitCode: 2,
      },
    ]);
    assert.equal(readFileSync(log, 'utf8'), 'signed-out\n');
  });

  it('fails as command not found without jerk on PATH', () => {
    assert.deepEqual(run(['jsh-fake'], { PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':') }), [
      { id: 'jsh-fake', message: "skill.token('jsh-fake'): jerk: command not found", exitCode: 127 },
    ]);
  });
});
