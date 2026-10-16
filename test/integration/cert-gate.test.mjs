/**
 * Certified = latest: the release publishes only the bytes cert-review
 * certified. scripts/cert-review/gate.mjs (run by publish.mjs before
 * `npm publish`) and record.mjs, driven as CLIs on fixture tarballs.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function tarball(name, manifest) {
  const dir = join(work, `${name}-src`);
  mkdirSync(join(dir, 'package/dist'), { recursive: true });
  writeFileSync(join(dir, 'package/package.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'package/dist/node.mjs'), `export const name = ${JSON.stringify(name)};\n`);
  const tgz = join(work, `${name}.tgz`);
  assert.equal(spawnSync('tar', ['-czf', tgz, '-C', dir, 'package']).status, 0);
  return { tgz, sha256: createHash('sha256').update(readFileSync(tgz)).digest('hex') };
}

function tool(script, args) {
  const env = { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '' };
  for (const k of ['NODE_TEST_CONTEXT', 'GITHUB_STEP_SUMMARY', 'GITHUB_OUTPUT']) delete env[k];
  const r = spawnSync(process.execPath, [join(tools, script), ...args], { encoding: 'utf8', env, timeout: 120_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function recordFile(name, record) {
  const file = join(work, `${name}.record.json`);
  writeFileSync(file, JSON.stringify(record));
  return file;
}

const good = tarball('good', { name: NAME, version: VERSION });
const other = tarball('other', { name: NAME, version: VERSION, description: 'other bytes' });
const certified = (sha256) => ({
  name: NAME,
  version: VERSION,
  certified: true,
  sha256,
  line: `certified ${NAME}@${VERSION} sha256=${sha256} (ci: local; known: none; not covered: bios real setup (manual))`,
});
const gate = (tgz, record, packed) => tool('gate.mjs', ['--tarball', tgz, '--record', record, '--sha256', packed]);

describe('cert-review gate: publish only certified bytes', () => {
  it('allows the tarball whose sha256 the verdict certified', () => {
    const r = gate(good.tgz, recordFile('ok', certified(good.sha256)), good.sha256);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`publish ${NAME}@${VERSION} sha256=${good.sha256}`));
  });

  it('refuses a FAIL verdict and prints its line', () => {
    const line = `cert-ci: FAIL ${NAME}@${VERSION}: the reviewer: a regression (ci: local)`;
    const r = gate(good.tgz, recordFile('fail', { name: NAME, version: VERSION, certified: false, sha256: null, line }), good.sha256);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /refuse to publish .*the verdict is not certified/);
    assert.ok(r.out.includes(line), r.out);
  });

  it('refuses bytes other than the certified ones', () => {
    const r = gate(other.tgz, recordFile('swap', certified(good.sha256)), other.sha256);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /refuse to publish .*verdict's sha256/);
  });

  it("refuses when the pack job's sha256 is not the tarball's", () => {
    const r = gate(good.tgz, recordFile('pack', certified(good.sha256)), other.sha256);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /refuse to publish .*pack job's sha256/);
  });

  it('refuses a certified line for another version', () => {
    const rec = certified(good.sha256);
    rec.line = rec.line.replace(VERSION, '9.8.6');
    const r = gate(good.tgz, recordFile('ver', rec), good.sha256);
    assert.equal(r.code, 2, r.out);
  });

  it('refuses when there is no record', () => {
    const r = gate(good.tgz, join(work, 'missing.json'), good.sha256);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /no cert-review record/);
  });
});

describe('cert-review record: the line comes from the artifact, not the reviewer', () => {
  function review(name, verdict) {
    const dir = join(work, `${name}-review`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'verdict.json'), JSON.stringify(verdict));
    return dir;
  }
  const record = (name, extra) => {
    const out = join(work, `rec-${name}`);
    const r = tool('record.mjs', ['--version', VERSION, '--review', review(name, { verdict: 'certified', known: [] }), '--out', out, '--dry-run', ...extra]);
    return { ...r, rec: JSON.parse(readFileSync(join(out, 'record.json'), 'utf8')) };
  };

  it('fails when the artifact is not what the pack job hashed', () => {
    const r = record('swap', ['--tarball', other.tgz, '--sha256', good.sha256]);
    assert.equal(r.code, 1, r.out);
    assert.equal(r.rec.certified, false);
    assert.equal(r.rec.sha256, null);
    assert.match(r.rec.line, new RegExp(`the artifact is sha256 ${other.sha256}, the pack job made ${good.sha256}`));
  });

  it('holds a certified verdict when a bench job failed', () => {
    const r = record('held-bench', ['--tarball', good.tgz, '--sha256', good.sha256, '--upstream', 'bench failure']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.rec.line, /held: a bench job ended failure, so the evidence is incomplete/);
    assert.equal(r.rec.certified, false);
  });

  it('calls a skipped bench job INCOMPLETE, never certified', () => {
    const r = record('held-skipped', ['--tarball', good.tgz, '--sha256', good.sha256, '--upstream', 'bench skipped']);
    assert.equal(r.code, 1, r.out);
    assert.equal(r.rec.certified, false);
    assert.equal(r.rec.sha256, null);
    assert.match(r.rec.line, /a bench job ended skipped, so the evidence is incomplete/);
  });

  it('a review job that failed and left no verdict is INCOMPLETE when nothing else is wrong', () => {
    const out = join(work, 'rec-noverdict');
    const empty = join(work, 'noverdict-review');
    mkdirSync(empty, { recursive: true });
    const r = tool('record.mjs', ['--version', VERSION, '--review', empty, '--out', out, '--dry-run', '--tarball', good.tgz, '--sha256', good.sha256, '--upstream', 'failure']);
    const rec = JSON.parse(readFileSync(join(out, 'record.json'), 'utf8'));
    assert.equal(r.code, 1, r.out);
    assert.equal(rec.certified, false);
    assert.match(rec.line, /held: the review job ended failure/);
    assert.match(rec.line, /no readable verdict\.json/);
  });

  it('holds a certified verdict from a review job that did not succeed', () => {
    const r = record('held-review', ['--tarball', good.tgz, '--sha256', good.sha256, '--upstream', 'failure']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.rec.line, /held: the review job ended failure/);
  });

  it('fails with no artifact at all', () => {
    const r = record('none', ['--sha256', good.sha256]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.rec.line, /no release artifact to check/);
  });
});
