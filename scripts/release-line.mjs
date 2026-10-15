#!/usr/bin/env node
/**
 * The release line, for the cert lane: after semantic-release publishes,
 * the package as the registry serves it, re-fetched and hashed, written into
 * the GitHub release's body:
 *
 *   @ai-ecoverse/slicc-jsh@X.Y.Z gitHead=… sha256=… integrity=sha512-… provenance=… onMain=true
 *
 * gitHead is the registry's, provenance the commit in npm's SLSA provenance
 * attestation; both must be the released commit, and the tarball's sha512
 * must be the registry's integrity, or this fails. onMain is whether main
 * contains gitHead (GitHub's compare main...gitHead is identical or behind).
 *
 * Usage (release.yml, after the release job):
 *   node scripts/release-line.mjs            # the v* tag on HEAD, if any
 *   node scripts/release-line.mjs 0.29.0 --dry-run   # print only
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { replaceSection } from './release-body.mjs';

const PROVENANCE = 'https://slsa.dev/provenance/v1';
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const name = manifest.name;
const repo =
  process.env.GITHUB_REPOSITORY ?? /github\.com[/:]([^/]+\/[^/.]+)/.exec(manifest.repository?.url ?? '')?.[1];
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();

let version = args.find((a) => !a.startsWith('--'));
let commit;
if (version) {
  commit = git('rev-list', '-n', '1', `v${version}`);
} else {
  commit = git('rev-parse', 'HEAD');
  const tag = git('tag', '--points-at', commit)
    .split('\n')
    .find((t) => /^v\d+\.\d+\.\d+/.test(t));
  if (!tag) {
    console.log(`no v* tag on ${commit}: nothing was published`);
    process.exit(0);
  }
  version = tag.slice(1);
}
const tag = `v${version}`;
const pkg = encodeURIComponent(name);

// The registry may take a while to serve a version it has just accepted.
async function fetchOk(url, what) {
  for (let i = 0; ; i++) {
    const res = await fetch(url);
    if (res.ok) return res;
    if (i >= 30) throw new Error(`${what}: ${res.status} ${res.statusText} (${url})`);
    await sleep(10_000);
  }
}

const meta = await (await fetchOk(`https://registry.npmjs.org/${pkg}/${version}`, 'version metadata')).json();
const tarball = Buffer.from(await (await fetchOk(meta.dist.tarball, 'tarball')).arrayBuffer());
const sha256 = createHash('sha256').update(tarball).digest('hex');
const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
if (integrity !== meta.dist.integrity) {
  throw new Error(`the tarball's ${integrity} is not the registry's ${meta.dist.integrity}`);
}

const attestations = await (
  await fetchOk(`https://registry.npmjs.org/-/npm/v1/attestations/${pkg}@${version}`, 'attestations')
).json();
const slsa = attestations.attestations?.find((a) => a.predicateType === PROVENANCE);
if (!slsa) throw new Error(`no ${PROVENANCE} attestation for ${name}@${version}`);
const statement = JSON.parse(Buffer.from(slsa.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
const provenance = statement.predicate?.buildDefinition?.resolvedDependencies?.find((d) => d.digest?.gitCommit)?.digest
  .gitCommit;
const subject = statement.subject?.find((s) => s.digest?.sha512);
if (subject && Buffer.from(subject.digest.sha512, 'hex').toString('base64') !== integrity.slice(7)) {
  throw new Error(`the attestation's subject is not this tarball (${subject.name})`);
}
for (const [what, sha] of [
  ['gitHead', meta.gitHead],
  ['provenance commit', provenance],
]) {
  if (sha !== commit) throw new Error(`${what} ${sha} is not ${tag}'s commit ${commit}`);
}

const compare = execFileSync('gh', ['api', `repos/${repo}/compare/main...${meta.gitHead}`, '--jq', '.status'], {
  encoding: 'utf8',
}).trim();
const onMain = compare === 'identical' || compare === 'behind';

const line = `${name}@${version} gitHead=${meta.gitHead} sha256=${sha256} integrity=${integrity} provenance=${provenance} onMain=${onMain}`;
console.log(line);
if (dryRun) process.exit(0);

// Only this job's section (<!-- release-line --> … <!-- /release-line -->)
// is replaced; the rest of the body, cert-review's section included, stays.
const body = execFileSync('gh', ['release', 'view', tag, '--json', 'body', '--jq', '.body'], { encoding: 'utf8' });
const notes = replaceSection(body, 'release-line', `\`\`\`\n${line}\n\`\`\``);
execFileSync('gh', ['release', 'edit', tag, '--notes-file', '-'], { input: notes, stdio: ['pipe', 'inherit', 'inherit'] });
console.log(`wrote the line into the ${tag} release`);
