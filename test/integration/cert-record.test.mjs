/**
 * cert-review's record.mjs, driven as a CLI on fixture tarballs: the line
 * comes from the artifact, never from the reviewer alone.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const tools = join(root, 'scripts/cert-review');
const work = mkdtempSync(join(tmpdir(), 'slicc-jsh-cert-gate-'));
after(() => rmSync(work, { recursive: true, force: true }));

const NAME = '@ai-ecoverse/slicc-jsh';
const VERSION = '9.8.7';
const SHA = 'c0ffee0000000000000000000000000000000000';
const QUIET_MS = 60_000;
const MAX_MS = 300_000;
const each = { timeout: MAX_MS + 30_000 };

const bin = join(work, 'bin');
const calls = join(work, 'calls.log');
mkdirSync(bin);
writeFileSync(calls, '');
const stub = (name, body) => {
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${calls}'\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
stub(
  'gh',
  `case "$*" in
  'api repos/ai-ecoverse/slicc-jsh/git/ref/tags/v${VERSION}') echo '{"object":{"type":"commit","sha":"${SHA}"}}' ;;
  'api repos/ai-ecoverse/slicc-jsh/compare/main...${SHA}') echo '{"status":"identical"}' ;;
  *) echo "gh stub: not stubbed: $*" >&2; exit 1 ;;
esac`
);
stub('npm', `[ "$*" = 'view ${NAME}@${VERSION} dist.integrity' ] || { echo "npm stub: not stubbed: $*" >&2; exit 1; }`);
stub('tar', `exec ${spawnSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).stdout.trim()} "$@"`);

function tarball(name, manifest) {
  const dir = join(work, `${name}-src`);
  mkdirSync(join(dir, 'package/dist'), { recursive: true });
  writeFileSync(join(dir, 'package/package.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'package/dist/node.mjs'), `export const name = ${JSON.stringify(name)};\n`);
  const tgz = join(work, `${name}.tgz`);
  assert.equal(spawnSync('tar', ['-czf', tgz, '-C', dir, 'package']).status, 0);
  return { tgz, sha256: createHash('sha256').update(readFileSync(tgz)).digest('hex') };
}

async function tool(script, args) {
  const env = { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', PATH: `${bin}:${process.env.PATH}` };
  for (const k of ['NODE_TEST_CONTEXT', 'GITHUB_STEP_SUMMARY', 'GITHUB_OUTPUT']) delete env[k];
  const child = spawn(process.execPath, [join(tools, script), ...args], { env, detached: true });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const t0 = Date.now();
  let seen = statSync(calls).size;
  let last = t0;
  let stalled = null;
  const watch = setInterval(() => {
    const size = statSync(calls).size;
    if (size !== seen) [seen, last] = [size, Date.now()];
    const now = Date.now();
    if (now - last >= QUIET_MS) stalled = `${script}: no progress (no tar, gh or npm call) for ${Math.round((now - last) / 1000)} s after ${Math.round((now - t0) / 1000)} s`;
    else if (now - t0 >= MAX_MS) stalled = `${script}: still running after ${Math.round((now - t0) / 1000)} s`;
    if (stalled) process.kill(-child.pid, 'SIGKILL');
  }, 1000);
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearInterval(watch);
  assert.equal(stalled, null, `${stalled}\n${out}`);
  return { code, out };
}

const good = tarball('good', { name: NAME, version: VERSION, gitHead: SHA });
const other = tarball('other', { name: NAME, version: VERSION, gitHead: SHA, description: 'other bytes' });

describe('cert-review record: the line comes from the artifact, not the reviewer', () => {
  function review(name, verdict) {
    const dir = join(work, `${name}-review`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'verdict.json'), JSON.stringify(verdict));
    return dir;
  }
  const record = async (name, extra) => {
    const out = join(work, `rec-${name}`);
    const r = await tool('record.mjs', ['--version', VERSION, '--review', review(name, { verdict: 'certified', known: [] }), '--out', out, '--dry-run', ...extra]);
    return { ...r, rec: JSON.parse(readFileSync(join(out, 'record.json'), 'utf8')) };
  };

  it('fails when the artifact is not what the pack job hashed', each, async () => {
    const r = await record('swap', ['--tarball', other.tgz, '--sha256', good.sha256]);
    assert.equal(r.code, 1, r.out);
    assert.equal(r.rec.certified, false);
    assert.equal(r.rec.sha256, null);
    assert.match(r.rec.line, new RegExp(`the artifact is sha256 ${other.sha256}, the pack job made ${good.sha256}`));
  });

  it('holds a certified verdict when a bench job failed', each, async () => {
    const r = await record('held-bench', ['--tarball', good.tgz, '--sha256', good.sha256, '--upstream', 'bench failure']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.rec.line, /held: a bench job ended failure, so the evidence is incomplete/);
    assert.equal(r.rec.certified, false);
  });

  it('calls a skipped bench job INCOMPLETE, never certified', each, async () => {
    const r = await record('held-skipped', ['--tarball', good.tgz, '--sha256', good.sha256, '--upstream', 'bench skipped']);
    assert.equal(r.code, 1, r.out);
    assert.equal(r.rec.certified, false);
    assert.equal(r.rec.sha256, null);
    assert.match(r.rec.line, /a bench job ended skipped, so the evidence is incomplete/);
  });

  it('holds a certified verdict from a review job that did not succeed', each, async () => {
    const r = await record('held-review', ['--tarball', good.tgz, '--sha256', good.sha256, '--upstream', 'failure']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.rec.line, /held: the review job ended failure/);
  });

  it('fails with no artifact at all', each, async () => {
    const r = await record('none', ['--sha256', good.sha256]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.rec.line, /no release artifact to check/);
  });

  it('asks the network nothing: every gh and npm call was one the stubs answer', () => {
    const lines = readFileSync(calls, 'utf8').trim().split('\n').filter((l) => !l.startsWith('tar '));
    assert.ok(lines.length >= 4, lines.join('\n'));
    for (const l of lines) assert.match(l, /^(gh api repos\/ai-ecoverse\/slicc-jsh\/(git\/ref\/tags\/v9\.8\.7|compare\/main\.\.\.c0ffee0+)|npm view @ai-ecoverse\/slicc-jsh@9\.8\.7 dist\.integrity)$/);
  });
});
