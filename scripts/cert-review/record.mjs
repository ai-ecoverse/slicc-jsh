#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { replaceSection } from '../release-body.mjs';
import { NAME, SEMVER } from './lib.mjs';

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    review: { type: 'string' },
    out: { type: 'string' },
    run: { type: 'string', default: '' },
    repo: { type: 'string', default: 'ai-ecoverse/slicc-jsh' },
    'dry-run': { type: 'boolean', default: false },
    notes: { type: 'string', default: '' },
  },
});

const WORKFLOW = '.github/workflows/release.yml';
const SLSA = 'https://slsa.dev/provenance/v1';
const NOT_COVERED = ['bios real setup (manual)'];
const DIST_TAG = 'certified tag: pending (ffj)';
const { version, repo } = values;
const problems = [];
const facts = {};
const one = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const fail = (what) => {
  problems.push(what);
  return undefined;
};
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const gh = (path) => JSON.parse(sh('gh', ['api', path]));

async function fetchOk(url, what) {
  for (let i = 0; ; i++) {
    const res = await fetch(url);
    if (res.ok) return res;
    if (i >= 12) throw new Error(`${what}: ${res.status} ${res.statusText} (${url})`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

async function download(meta) {
  const url = new URL(meta.dist.tarball);
  if (url.origin !== 'https://registry.npmjs.org') return fail(`the tarball is at ${url.origin}`);
  const bytes = Buffer.from(await (await fetchOk(url, 'tarball')).arrayBuffer());
  const sha512 = createHash('sha512').update(bytes);
  facts.integrity = `sha512-${sha512.copy().digest('base64')}`;
  facts.sha512 = sha512.digest('hex');
  facts.sha256 = createHash('sha256').update(bytes).digest('hex');
  facts.gitHead = meta.gitHead;
  if (meta.dist.integrity !== facts.integrity) fail(`dist.integrity is ${meta.dist.integrity}, the tarball is ${facts.integrity}`);
  return bytes;
}

function checkManifest(meta, tgz) {
  const files = sh('tar', ['-tzf', tgz]).trim().split('\n');
  const manifest = JSON.parse(sh('tar', ['-xzf', tgz, '-O', 'package/package.json']));
  facts.files = files.length;
  if (manifest.name !== NAME || manifest.version !== version) fail(`the tarball's package.json is ${manifest.name}@${manifest.version}`);
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
    const v = manifest[field];
    const n = Array.isArray(v) ? v.length : Object.keys(v ?? {}).length;
    if (n) fail(`${field} has ${n} entries: ${JSON.stringify(v)}`);
  }
  const scripts = Object.keys(manifest.scripts ?? {}).filter((s) => /^(pre|post)?install$|^prepare$|^prepack$/.test(s));
  if (scripts.length) fail(`lifecycle scripts in the published package.json: ${scripts.join(', ')}`);
  if (files.some((f) => f.endsWith('/binding.gyp'))) fail('the tarball has a binding.gyp (an implicit install script)');
  if (meta.hasInstallScript) fail('npm says hasInstallScript');
  const stray = files.filter((f) => !/^package\/(dist\/|LICENSE$|NOTICE$|README\.md$|package\.json$)/.test(f));
  if (stray.length) fail(`files outside the allowlist: ${stray.slice(0, 5).join(', ')}`);
}

async function provenance(meta) {
  const url = meta.dist.attestations?.url;
  if (!url) return fail('no attestations on npm');
  const prov = ((await (await fetchOk(url, 'attestations')).json()).attestations ?? []).find((b) => b.predicateType === SLSA);
  if (!prov) return fail('no SLSA provenance attestation');
  const statement = JSON.parse(Buffer.from(prov.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
  const subject = statement.subject?.find((s) => s.name === `pkg:npm/%40ai-ecoverse/slicc-jsh@${version}`);
  if (subject?.digest?.sha512 !== facts.sha512) fail("the provenance subject isn't this tarball's sha512");
  const build = statement.predicate?.buildDefinition ?? {};
  const wf = build.externalParameters?.workflow ?? {};
  const commit = build.resolvedDependencies?.find((d) => d.digest?.gitCommit)?.digest?.gitCommit;
  facts.provenance = { workflow: wf, gitCommit: commit, invocation: statement.predicate?.runDetails?.metadata?.invocationId };
  if (wf.repository !== `https://github.com/${repo}`) fail(`provenance repository is ${wf.repository}`);
  if (wf.path !== WORKFLOW) fail(`provenance workflow is ${wf.path}`);
  if (wf.ref !== 'refs/heads/main') fail(`provenance ref is ${wf.ref}`);
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) return fail(`provenance gitCommit is ${commit}`);
  if (commit !== meta.gitHead) fail(`provenance gitCommit ${commit} isn't the package's gitHead ${meta.gitHead}`);
  return commit;
}

function signatures(dir) {
  const audit = join(dir, 'audit');
  mkdirSync(audit);
  writeFileSync(join(audit, 'package.json'), '{"private":true}\n');
  sh('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `${NAME}@${version}`], { cwd: audit });
  let out;
  try {
    out = sh('npm', ['audit', 'signatures'], { cwd: audit });
  } catch (error) {
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    fail(`npm audit signatures failed: ${one(out).slice(0, 300)}`);
  }
  facts.signatures = one(out);
  if (!/verified attestation/.test(out)) fail('npm audit signatures verified no attestation');
}

function onMain(commit) {
  let ref = gh(`repos/${repo}/git/ref/tags/v${version}`).object;
  if (ref.type === 'tag') ref = gh(`repos/${repo}/git/tags/${ref.sha}`).object;
  facts.tagCommit = ref.sha;
  if (ref.sha !== commit) fail(`tag v${version} is ${ref.sha}, provenance says ${commit}`);
  const cmp = gh(`repos/${repo}/compare/main...${commit}`);
  facts.onMain = cmp.status === 'identical' || cmp.status === 'behind';
  facts.compare = cmp.status;
  if (!facts.onMain) fail(`${commit} is ${cmp.status} of main, not on main`);
  facts.commit = commit;
}

async function supplyChain() {
  const meta = JSON.parse(sh('npm', ['view', `${NAME}@${version}`, '--json']));
  if (meta.name !== NAME || meta.version !== version) return fail(`npm view answered ${meta.name}@${meta.version}`);
  const bytes = await download(meta);
  if (!bytes) return undefined;
  const dir = mkdtempSync(join(tmpdir(), 'cert-record-'));
  try {
    const tgz = join(dir, 'package.tgz');
    writeFileSync(tgz, bytes);
    checkManifest(meta, tgz);
    const commit = await provenance(meta);
    if (!commit) return undefined;
    signatures(dir);
    onMain(commit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return true;
}

function knownRefs(list) {
  const out = [];
  for (const k of list) {
    const m = /^(?:https:\/\/github\.com\/)?(?:([\w.-]+\/[\w.-]+)(?:#|\/issues\/))?#?(\d+)$/.exec(k);
    if (!m) {
      problems.push(`known "${k}" is not an issue reference`);
      continue;
    }
    const r = m[1] ?? repo;
    try {
      const issue = gh(`repos/${r}/issues/${m[2]}`);
      if (issue.pull_request) problems.push(`known ${k} is a pull request, not an issue`);
      out.push(r === repo ? `#${m[2]}` : `${r}#${m[2]}`);
    } catch {
      problems.push(`known ${k} is not an issue in ${r}`);
    }
  }
  return out;
}

function readVerdict() {
  try {
    const v = JSON.parse(readFileSync(join(values.review, 'verdict.json'), 'utf8'));
    if (v?.verdict !== 'certified' && v?.verdict !== 'fail') {
      problems.push(`verdict.json says "${one(v?.verdict)}", neither certified nor fail`);
      return undefined;
    }
    const known = Array.isArray(v.known) ? v.known.map((k) => one(k).slice(0, 120)).filter(Boolean) : [];
    if (v.known !== undefined && !Array.isArray(v.known)) problems.push('verdict.json "known" is not a list');
    return { verdict: v.verdict, known: knownRefs(known), reason: one(v.reason).slice(0, 300) };
  } catch (error) {
    problems.push(`no readable verdict.json (${one(error.message)})`);
    return undefined;
  }
}

if (!SEMVER.test(version ?? '')) {
  console.error('record: --version must be x.y.z');
  process.exit(2);
}
try {
  await supplyChain();
} catch (error) {
  problems.push(`supply-chain check failed: ${one(error.stderr || error.message).slice(0, 300)}`);
}
const review = readVerdict();
const ci = values.run ? `ci: ${values.run}` : 'ci: local';
const tail = `not covered: ${NOT_COVERED.join(', ')}`;
let line;
if (!problems.length && review?.verdict === 'certified') {
  line = `certified ${NAME}@${version} sha256=${facts.sha256} (${ci}; known: ${review.known.length ? review.known.join(', ') : 'none'}; ${tail}; ${DIST_TAG})`;
} else {
  const why = [
    ...(review?.verdict === 'fail' ? [`the reviewer: ${review.reason || 'no reason given'}`] : []),
    ...(review?.verdict === 'certified' ? ['the reviewer certified it'] : []),
    ...problems,
  ];
  line = `cert-ci: FAIL ${NAME}@${version}: ${why.join('; ')} (${ci})`;
}
const certified = line.startsWith('certified ');
const comment = existsSync(join(values.review, 'comment.md'))
  ? readFileSync(join(values.review, 'comment.md'), 'utf8').trim()
  : '**Cert review:** the reviewer wrote no comment.';
const checks = [
  `- npm integrity: ${facts.integrity ?? '?'} (sha256 ${facts.sha256 ?? '?'}), computed here from the registry tarball`,
  `- provenance: ${facts.provenance ? `${facts.provenance.workflow.path}@${facts.provenance.workflow.ref}, commit ${facts.provenance.gitCommit}` : '?'}`,
  `- gitHead ${facts.gitHead ?? '?'}, tag v${version} ${facts.tagCommit ?? '?'}, onMain=${facts.onMain ?? '?'} (main...commit ${facts.compare ?? '?'})`,
  `- signatures: ${facts.signatures ?? '?'}`,
  certified ? `- dist-tag: ${DIST_TAG}: thr_ffj7dxt28v re-hashes the registry tarball and moves the certified dist-tag by hand from this line` : '- dist-tag: not moved (not certified)',
].join('\n');
const trouble = problems.length ? `\n\n**Problems:**\n${problems.map((p) => `- ${p}`).join('\n')}` : '';
const section = `${comment}\n\n**Checked by record, in code:**\n${checks}\n\n\`\`\`\n${line}\n\`\`\`${trouble}`;

mkdirSync(values.out, { recursive: true });
writeFileSync(join(values.out, 'line.txt'), `${line}\n`);
writeFileSync(join(values.out, 'section.md'), `${section}\n`);
writeFileSync(
  join(values.out, 'record.json'),
  `${JSON.stringify({ name: NAME, version, certified, line, commit: facts.commit ?? null, facts, problems, review }, null, 2)}\n`
);
console.log(line);
for (const p of problems) console.error(`problem: ${p}`);

if (values.notes) {
  const body = existsSync(values.notes) ? readFileSync(values.notes, 'utf8') : '';
  writeFileSync(values.notes, replaceSection(body, 'cert-review', section));
} else if (!values['dry-run']) {
  let body = null;
  try {
    body = sh('gh', ['release', 'view', `v${version}`, '-R', repo, '--json', 'body', '--jq', '.body']);
  } catch {
    console.error(`::warning::no GitHub release for v${version}: the line is only in the status and the artifact`);
  }
  if (body !== null) {
    execFileSync('gh', ['release', 'edit', `v${version}`, '-R', repo, '--notes-file', '-'], {
      input: replaceSection(body, 'cert-review', section),
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    console.log(`wrote the cert-review section into the v${version} release`);
  }
}
process.exit(certified ? 0 : 1);
