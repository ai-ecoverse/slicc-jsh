#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { gh, run } from './checks.mjs';
import { root } from './lib.mjs';

const { values } = parseArgs({ options: { base: { type: 'string' }, head: { type: 'string' }, repo: { type: 'string', default: 'ai-ecoverse/slicc-jsh' }, run: { type: 'string', default: '' }, 'dry-run': { type: 'boolean', default: false }, dir: { type: 'string', default: '' }, statuses: { type: 'string', default: '' } } });
const repoDir = values.dir || root;
const given = values.statuses ? JSON.parse(readFileSync(values.statuses, 'utf8')) : null;
const merges = run('git', ['log', '--merges', '--first-parent', '--format=%H %P%x09%s', `${values.base}..${values.head}`], { cwd: repoDir })
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [ids, subject] = l.split('\t');
    const [sha, , second] = ids.split(' ');
    return { sha, head: second, pr: Number(/^Merge pull request #(\d+)/.exec(subject)?.[1] ?? 0), subject };
  });
const problems = [];
const rows = [];
const summary = [];
if (!merges.length) problems.push(`no pull request merge commits in ${values.base.slice(0, 8)}..${values.head.slice(0, 8)}`);
for (const m of merges) {
  if (!m.pr) {
    problems.push(`${m.sha.slice(0, 8)} is not a pull request merge: ${m.subject}`);
    continue;
  }
  const status = given ? given[m.head] : gh(`repos/${values.repo}/commits/${m.head}/statuses?per_page=100`).find((x) => x.context === 'cert-review');
  rows.push(`#${m.pr} head ${m.head.slice(0, 8)}: ${status ? `${status.state}: ${status.description}` : 'no cert-review status'}`);
  summary.push(`#${m.pr} ${status?.state === 'success' ? (status.description.startsWith('certified ') ? `certified at ${m.head.slice(0, 12)}` : 'not behaviour') : 'NOT certified'}`);
  if (status?.state !== 'success') problems.push(`#${m.pr} (head ${m.head.slice(0, 8)}) has ${status ? `a ${status.state} cert-review` : 'no cert-review status'}`);
}
const text = `${rows.map((r) => `- ${r}`).join('\n')}${problems.length ? `\n\nNot certified:\n${problems.map((p) => `- ${p}`).join('\n')}` : ''}`;
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
const description = `${problems.length ? 'not certified: ' : ''}${summary.join('; ')}`.slice(0, 140);
console.log(`group status: ${problems.length ? 'failure' : 'success'}: ${description}`);
if (!values['dry-run'] && merges.length) {
  execFileSync('gh', ['api', `repos/${values.repo}/statuses/${values.head}`, '-f', `state=${problems.length ? 'failure' : 'success'}`, '-f', 'context=cert-review', '-f', `description=${description}`, '-f', `target_url=${values.run}`], { stdio: ['ignore', 'ignore', 'inherit'] });
  console.log(`cert-review status on the group head ${values.head.slice(0, 8)}: ${description}`);
}
process.exit(problems.length ? 1 : 0);
