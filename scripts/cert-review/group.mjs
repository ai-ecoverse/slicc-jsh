#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { gh, run } from './checks.mjs';
import { root } from './lib.mjs';

const { values } = parseArgs({ options: { base: { type: 'string' }, head: { type: 'string' }, repo: { type: 'string', default: 'ai-ecoverse/slicc-jsh' } } });
const merges = run('git', ['log', '--merges', '--first-parent', '--format=%H %P%x09%s', `${values.base}..${values.head}`], { cwd: root })
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
if (!merges.length) problems.push(`no pull request merge commits in ${values.base.slice(0, 8)}..${values.head.slice(0, 8)}`);
for (const m of merges) {
  if (!m.pr) {
    problems.push(`${m.sha.slice(0, 8)} is not a pull request merge: ${m.subject}`);
    continue;
  }
  const status = gh(`repos/${values.repo}/commits/${m.head}/statuses?per_page=100`).find((x) => x.context === 'cert-review');
  rows.push(`#${m.pr} head ${m.head.slice(0, 8)}: ${status ? `${status.state}: ${status.description}` : 'no cert-review status'}`);
  if (status?.state !== 'success') problems.push(`#${m.pr} (head ${m.head.slice(0, 8)}) has ${status ? `a ${status.state} cert-review` : 'no cert-review status'}`);
}
const text = `${rows.map((r) => `- ${r}`).join('\n')}${problems.length ? `\n\nNot certified:\n${problems.map((p) => `- ${p}`).join('\n')}` : ''}`;
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
process.exit(problems.length ? 1 : 0);
