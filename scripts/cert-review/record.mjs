#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { replaceSection } from '../release-body.mjs';
import { checkManifest, knownRefs, one, run, tagOnMain } from './checks.mjs';
import { NAME, SEMVER, sha, sri } from './lib.mjs';

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    review: { type: 'string' },
    out: { type: 'string' },
    tarball: { type: 'string', default: '' },
    sha256: { type: 'string', default: '' },
    upstream: { type: 'string', default: '' },
    run: { type: 'string', default: '' },
    repo: { type: 'string', default: 'ai-ecoverse/slicc-jsh' },
    'dry-run': { type: 'boolean', default: false },
    replay: { type: 'boolean', default: false },
    notes: { type: 'string', default: '' },
  },
});

const NOT_COVERED = ['bios real setup (manual)'];
const { version, repo } = values;
const problems = [];
const facts = {};
const fail = (what) => {
  problems.push(what);
  return undefined;
};

function onRegistry() {
  try {
    const integrity = run('npm', ['view', `${NAME}@${version}`, 'dist.integrity']).trim();
    if (!integrity) return 'absent';
    return integrity === facts.integrity ? 'these bytes' : `other bytes (${integrity})`;
  } catch {
    return 'absent';
  }
}

function artifact() {
  const tgz = resolve(values.tarball || '.');
  if (!values.tarball || !existsSync(tgz)) return fail('no release artifact to check');
  facts.sha256 = sha('sha256', tgz);
  facts.integrity = sri(tgz);
  const expected = values.sha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) fail(`the pack job's sha256 is "${one(expected)}"`);
  else if (expected !== facts.sha256) fail(`the artifact is sha256 ${facts.sha256}, the pack job made ${expected}`);
  checkManifest(tgz, version, fail, facts);
  const commit = tagOnMain(repo, version, fail, facts);
  if (facts.gitHead !== commit) fail(`the tarball's gitHead is ${facts.gitHead}, tag v${version} is ${commit}`);
  facts.commit = commit;
  facts.npm = onRegistry();
  if (facts.npm.startsWith('other bytes') && !values.replay) fail(`npm already has v${version} with ${facts.npm}`);
  return true;
}

function readVerdict() {
  try {
    const v = JSON.parse(readFileSync(join(values.review, 'verdict.json'), 'utf8'));
    if (v?.verdict !== 'certified' && v?.verdict !== 'fail') {
      problems.push(`verdict.json says "${one(v?.verdict)}", neither certified nor fail`);
      return undefined;
    }
    if (v.known !== undefined && !Array.isArray(v.known)) problems.push('verdict.json "known" is not a list');
    const known = Array.isArray(v.known) ? v.known.map((k) => one(k).slice(0, 120)).filter(Boolean) : [];
    return { verdict: v.verdict, known: knownRefs(repo, known, problems), reason: one(v.reason).slice(0, 300) };
  } catch (error) {
    problems.push(`no readable verdict.json (${one(error.message)})`);
    return undefined;
  }
}

if (!SEMVER.test(version ?? '') || !values.review || !values.out) {
  console.error('record: --version x.y.z, --review and --out are required');
  process.exit(2);
}
if (values.upstream && values.upstream !== 'success') {
  problems.push(`held: ${values.upstream.startsWith('bench ') ? `a bench job ended ${values.upstream.slice(6)}, so the evidence is incomplete` : `the review job ended ${values.upstream}`}`);
}
try {
  artifact();
} catch (error) {
  problems.push(`artifact check failed: ${one(error.stderr || error.message).slice(0, 300)}`);
}
const review = readVerdict();
const ci = values.run ? `ci: ${values.run}` : 'ci: local';
let line;
if (!problems.length && review?.verdict === 'certified') {
  line = `certified ${NAME}@${version} sha256=${facts.sha256} (${ci}; known: ${review.known.length ? review.known.join(', ') : 'none'}; not covered: ${NOT_COVERED.join(', ')})`;
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
  `- artifact: sha256 ${facts.sha256 ?? '?'} (the pack job's: ${values.sha256 || '?'}), ${facts.integrity ?? '?'}, re-hashed here`,
  `- gitHead ${facts.gitHead ?? '?'}, tag v${version} ${facts.tagCommit ?? '?'}, onMain=${facts.onMain ?? '?'} (main...tag ${facts.compare ?? '?'})`,
  `- npm before publish: ${facts.npm ?? 'not checked'}${values.replay ? ' (a replay of a published version: its npm bytes predate the packed gitHead)' : ''}. Only these bytes are published (to latest, with provenance), and they are checked on npm afterwards.`,
].join('\n');
const trouble = problems.length ? `\n\n**Problems:**\n${problems.map((p) => `- ${p}`).join('\n')}` : '';
const section = `${comment}\n\n**Checked by record, in code:**\n${checks}\n\n\`\`\`\n${line}\n\`\`\`${trouble}`;

mkdirSync(values.out, { recursive: true });
writeFileSync(join(values.out, 'line.txt'), `${line}\n`);
writeFileSync(join(values.out, 'section.md'), `${section}\n`);
writeFileSync(
  join(values.out, 'record.json'),
  `${JSON.stringify({ name: NAME, version, certified, sha256: certified ? facts.sha256 : null, line, commit: facts.commit ?? null, facts, problems, review }, null, 2)}\n`
);
console.log(line);
for (const p of problems) console.error(`problem: ${p}`);

if (values.notes) {
  const body = existsSync(values.notes) ? readFileSync(values.notes, 'utf8') : '';
  writeFileSync(values.notes, replaceSection(body, 'cert-review', section));
} else if (!values['dry-run'] && !values.replay) {
  let body = null;
  try {
    body = run('gh', ['release', 'view', `v${version}`, '-R', repo, '--json', 'body', '--jq', '.body']);
  } catch {
    console.error(`::warning::no GitHub release for v${version}: the line is only in the status and the artifact`);
  }
  if (body !== null) {
    execFileSync('gh', ['release', 'edit', `v${version}`, '-R', repo, '--notes-file', '-'], { input: replaceSection(body, 'cert-review', section), stdio: ['pipe', 'inherit', 'inherit'] });
    console.log(`wrote the cert-review section into the v${version} release`);
  }
}
process.exit(certified ? 0 : 1);
