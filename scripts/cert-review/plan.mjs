#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ROWS, SKIP } from '../../test/cert-review/fixtures.mjs';
import { NAME, SEMVER, atLeast, readJson, root } from './lib.mjs';

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    prev: { type: 'string', default: '' },
    out: { type: 'string' },
    repo: { type: 'string', default: process.env.GH_REPO ?? 'ai-ecoverse/slicc-jsh' },
  },
});
const { version, repo } = values;
if (!SEMVER.test(version ?? '')) {
  console.error('plan: --version must be x.y.z');
  process.exit(2);
}
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const gh = (...a) => execFileSync('gh', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const tags = git('tag', '--list', 'v*')
  .split('\n')
  .map((t) => t.slice(1))
  .filter((v) => SEMVER.test(v))
  .sort((a, b) => (atLeast(a, b) ? (a === b ? 0 : 1) : -1));
const earlier = tags.filter((t) => t !== version && atLeast(version, t));
const certifiedLine = (v) => new RegExp(`certified ${NAME.replace('/', '\\/')}@${v.replaceAll('.', '\\.')} sha256=[0-9a-f]{64}`);

function resolvePrev() {
  const releases = JSON.parse(gh('api', `repos/${repo}/releases?per_page=100`, '--paginate', '--slurp')).flat();
  const bodies = new Map(releases.map((r) => [r.tag_name.replace(/^v/, ''), r.body ?? '']));
  for (const v of [...earlier].reverse()) {
    const body = bodies.get(v) ?? '';
    const section = /<!-- cert-review -->([\s\S]*?)<!-- \/cert-review -->/.exec(body)?.[1] ?? '';
    if (certifiedLine(v).test(section)) return { prev: v, from: `the v${v} release body's cert-review line` };
  }
  const tag = JSON.parse(execFileSync('npm', ['view', NAME, 'dist-tags', '--json'], { encoding: 'utf8' })).certified;
  if (tag && earlier.includes(tag)) return { prev: tag, from: `npm's certified dist-tag (no earlier release body carries a cert-review line)` };
  return { prev: null, from: 'no certified earlier release' };
}

const resolved = values.prev ? { prev: values.prev, from: 'the dispatch input' } : resolvePrev();
const { prev } = resolved;
if (!prev || !earlier.includes(prev)) {
  console.error(`plan: no previous certified tag before v${version} (${resolved.from})`);
  process.exit(3);
}

const commit = git('rev-parse', `v${version}^{commit}`);
const prevCommit = git('rev-parse', `v${prev}^{commit}`);
const touched = git('diff', '--name-only', `v${prev}`, `v${version}`).split('\n').filter(Boolean);
const log = git('log', '--format=%H%x09%s', `v${prev}..v${version}`)
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [sha, ...s] = l.split('\t');
    return { sha, subject: s.join('\t') };
  });
const releasesBetween = tags.filter((t) => atLeast(t, prev) && t !== prev && atLeast(version, t));
const prNumbers = [...new Set(log.flatMap((c) => [...c.subject.matchAll(/(?:Merge pull request #|\(#)(\d+)/g)].map((m) => Number(m[1]))))].sort((a, b) => a - b);
const prs = [];
for (const n of prNumbers) {
  try {
    const p = JSON.parse(gh('pr', 'view', String(n), '-R', repo, '--json', 'number,title,body,files,mergeCommit,url'));
    if (!p.mergeCommit) continue;
    const files = (p.files ?? []).map((f) => f.path);
    const fixes = [...new Set([...(p.body ?? '').matchAll(/\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+(?:ai-ecoverse\/slicc-jsh)?#(\d+)/gi)].map((m) => Number(m[1])))];
    prs.push({
      number: n,
      title: p.title,
      url: p.url,
      fixes,
      kind: /^(\w+)(\(.+?\))?!?:/.exec(p.title)?.[1] ?? 'other',
      tests: files.filter((f) => /^test\/(integration\/[^/]+\.test\.mjs|golden\/fixtures\/[^/]+|jsh\/fixtures\/[^/]+|integration\/cert\/|node-parallel\/|browser\/)/.test(f)),
      src: files.filter((f) => f.startsWith('src/') || f.startsWith('scripts/build')),
    });
  } catch (error) {
    prs.push({ number: n, error: String(error.message).slice(0, 200) });
  }
}

const pkg = readJson(join(root, 'package.json'));
const kernels = Object.entries(pkg.devDependencies)
  .filter(([k]) => k.startsWith('kernel-cert-'))
  .map(([k, v]) => `${k.slice('kernel-cert-'.length)}=${v.split('@').at(-1)}`);
const testUnits = (files) => [
  ...new Set(
    files.map((f) => {
      const m = /^test\/(golden|jsh)\/fixtures\/([^/]+)/.exec(f);
      if (m) return `${m[1]} fixture ${m[2]}`;
      return f;
    })
  ),
];
const plan = {
  name: NAME,
  version,
  prev,
  prevFrom: resolved.from,
  commit,
  prevCommit,
  releasesBetween,
  kernels,
  touched,
  commits: log,
  prs,
  fixtureDirsSkipped: SKIP,
  rows: ROWS.map((r) => r.name),
};
writeFileSync(join(out, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
writeFileSync(join(out, 'touched.txt'), `${touched.join('\n')}\n`);

const md = [
  `# Cert review plan: ${NAME}@${version} (delta from ${prev})`,
  '',
  `- previous: v${prev} (${prevCommit.slice(0, 8)}), from ${resolved.from}`,
  `- subject: v${version} (${commit.slice(0, 8)}); releases in the delta: ${releasesBetween.map((v) => `v${v}`).join(', ')}`,
  `- kernels (devDependency aliases, users enforce): ${kernels.join(', ')}, plus the tag's own devDependency kernel`,
  `- trees: tag = v${version}'s tests with the published dist; neg = the same tests with v${prev}'s published dist`,
  '',
  '## Pull requests in the delta',
  '',
  ...prs.map((p) =>
    p.error
      ? `- #${p.number}: could not read (${p.error})`
      : `- #${p.number}: ${p.title}${p.fixes.length ? ` (fixes ${p.fixes.map((f) => `#${f}`).join(', ')})` : ''}\n  - tests: ${testUnits(p.tests).join(', ') || 'none'}\n  - NEGATIVE: ${p.kind === 'fix' || p.kind === 'feat' || p.kind === 'perf' ? (p.tests.length ? 'each test above must fail in neg and pass in tag' : 'no committed test: a test gap') : 'not a behaviour change'}`
  ),
  '',
  '## Commits',
  '',
  ...log.map((c) => `- ${c.sha.slice(0, 8)} ${c.subject}`),
  '',
  '## Method (test/cert-review/review.txt)',
  '',
  '1. Bytes: the published tarball against the rebuild at the tag.',
  '2. Suites per kernel: golden, jsh parity, integration, test:cert, node-parallel on tag; on neg for every unit the delta touched and every unit that failed on tag.',
  `3. m-fixtures per kernel (test/fixtures/cert-review/fx) against host Node 22.22.0 as user cone, for v${version} and v${prev}; rows ${ROWS.map((r) => r.name).join(', ')} under enforce as root, cone and cone2.`,
  '4. The browser suite on tag with its devDependency kernel.',
  '5. The delta: every fix has a committed test that fails in neg (the NEGATIVE); known issues are filed.',
  '6. Not covered here: the bios real-setup run (manual).',
  '',
].join('\n');
writeFileSync(join(out, 'plan.md'), md);
console.log(`plan: ${NAME}@${version} from ${prev} (${resolved.from}), ${log.length} commit(s), ${prs.length} PR(s), ${touched.length} file(s)`);
