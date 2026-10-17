#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { replaceSection } from '../release-body.mjs';
import { gh, run } from './checks.mjs';
import { root } from './lib.mjs';

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    repo: { type: 'string', default: process.env.GH_REPO ?? 'ai-ecoverse/slicc-jsh' },
    release: { type: 'string', default: '' },
    'dry-run': { type: 'boolean', default: false },
    dir: { type: 'string', default: '' },
  },
});
const { repo } = values;
const merges = run('git', ['log', '--merges', '--first-parent', '--reverse', '--format=%H %P%x09%s', `${values.from}..${values.to}`], { cwd: values.dir || root })
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [ids, subject] = l.split('\t');
    const [sha, , second] = ids.split(' ');
    return { sha, head: second, pr: Number(/^Merge pull request #(\d+)/.exec(subject)?.[1] ?? 0) };
  })
  .filter((m) => m.pr);
const statusOf = (sha) => gh(`repos/${repo}/commits/${sha}/statuses?per_page=100`).find((x) => x.context === 'cert-review');

const lines = [];
for (const m of merges) {
  const s = statusOf(m.head);
  const title = (() => {
    try {
      return gh(`repos/${repo}/pulls/${m.pr}`).title;
    } catch {
      return '';
    }
  })();
  lines.push(`- #${m.pr} ${title}: ${s ? `**${s.state}**: ${s.description} ([run](${s.target_url}))` : '**no cert-review status** on its head'}`);
  if (values.release || !s) continue;
  if (statusOf(m.sha)) continue;
  const args = ['api', `repos/${repo}/statuses/${m.sha}`, '-f', `state=${s.state}`, '-f', 'context=cert-review', '-f', `description=${s.description}`, '-f', `target_url=${s.target_url}`];
  if (values['dry-run']) console.log(`would copy #${m.pr}'s cert-review (${s.state}) onto ${m.sha.slice(0, 8)}`);
  else {
    execFileSync('gh', args, { stdio: ['ignore', 'ignore', 'inherit'] });
    console.log(`copied #${m.pr}'s cert-review (${s.state}) from ${m.head.slice(0, 8)} onto ${m.sha.slice(0, 8)}`);
  }
}
if (values.release) {
  const section = `**Cert review**: every pull request in this release, with its \`cert-review\` from the pull request check:\n\n${lines.join('\n') || '- (no pull request merges)'}`;
  if (values['dry-run']) console.log(section);
  else {
    const body = run('gh', ['release', 'view', values.release, '-R', repo, '--json', 'body', '--jq', '.body']);
    execFileSync('gh', ['release', 'edit', values.release, '-R', repo, '--notes-file', '-'], { input: replaceSection(body, 'cert-review', section), stdio: ['pipe', 'inherit', 'inherit'] });
    console.log(`wrote the cert-review section of ${values.release} (${lines.length} pull request(s))`);
  }
} else console.log(lines.join('\n'));
