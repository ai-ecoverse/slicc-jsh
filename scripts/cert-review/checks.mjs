import { execFileSync } from 'node:child_process';
import { NAME } from './lib.mjs';

export const one = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();

export const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts });
export const gh = (path) => JSON.parse(run('gh', ['api', path]));

export function checkManifest(tgz, version, fail, facts) {
  const files = run('tar', ['-tzf', tgz]).trim().split('\n');
  const manifest = JSON.parse(run('tar', ['-xzf', tgz, '-O', 'package/package.json']));
  facts.files = files.length;
  facts.gitHead = manifest.gitHead ?? null;
  if (manifest.name !== NAME || manifest.version !== version) fail(`the tarball's package.json is ${manifest.name}@${manifest.version}`);
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
    const v = manifest[field];
    const n = Array.isArray(v) ? v.length : Object.keys(v ?? {}).length;
    if (n) fail(`${field} has ${n} entries: ${JSON.stringify(v)}`);
  }
  const scripts = Object.keys(manifest.scripts ?? {}).filter((s) => /^(pre|post)?install$|^prepare$|^prepack$/.test(s));
  if (scripts.length) fail(`lifecycle scripts in the package.json: ${scripts.join(', ')}`);
  if (files.some((f) => f.endsWith('/binding.gyp'))) fail('the tarball has a binding.gyp (an implicit install script)');
  const stray = files.filter((f) => !/^package\/(dist\/|LICENSE$|NOTICE$|README\.md$|package\.json$)/.test(f));
  if (stray.length) fail(`files outside the allowlist: ${stray.slice(0, 5).join(', ')}`);
  return manifest;
}

export function tagOnMain(repo, version, fail, facts) {
  let ref = gh(`repos/${repo}/git/ref/tags/v${version}`).object;
  if (ref.type === 'tag') ref = gh(`repos/${repo}/git/tags/${ref.sha}`).object;
  facts.tagCommit = ref.sha;
  const cmp = gh(`repos/${repo}/compare/main...${ref.sha}`);
  facts.compare = cmp.status;
  facts.onMain = cmp.status === 'identical' || cmp.status === 'behind';
  if (!facts.onMain) fail(`tag v${version} (${ref.sha}) is ${cmp.status} of main, not on main`);
  return ref.sha;
}

export function knownRefs(repo, list, problems) {
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
