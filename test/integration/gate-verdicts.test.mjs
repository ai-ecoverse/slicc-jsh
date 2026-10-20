import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOWS = ['ci.yml', 'cert-review.yml', 'release.yml'];
const text = Object.fromEntries(WORKFLOWS.map((f) => [f, readFileSync(join(root, '.github/workflows', f), 'utf8')]));

const jobOf = (file, job) => {
  const lines = text[file].split('\n');
  const start = lines.findIndex((l) => l === `  ${job}:`);
  assert.ok(start >= 0, `${file}: no job ${job}`);
  const end = lines.findIndex((l, i) => i > start && /^ {2}[\w-]+:$/.test(l));
  return lines.slice(start, end < 0 ? lines.length : end);
};

const runOf = (file, job, name) => {
  const lines = jobOf(file, job);
  const at = lines.findIndex((l) => /^\s+- name: /.test(l) && l.trim().slice('- name: '.length).startsWith(name));
  assert.ok(at >= 0, `${file} ${job}: no step "${name}"`);
  const indent = lines[at].indexOf('-');
  const end = lines.findIndex((l, i) => i > at && l.trim() && l.search(/\S/) <= indent);
  const step = lines.slice(at, end < 0 ? lines.length : end);
  const r = step.findIndex((l) => /^\s+run: /.test(l));
  assert.ok(r >= 0, `${file} ${job} "${name}": no run`);
  const head = step[r].trim().slice('run: '.length);
  if (head !== '|') return `${head}\n`;
  const body = [];
  const runIndent = step[r].search(/\S/);
  for (const l of step.slice(r + 1)) {
    if (l.trim() && l.search(/\S/) <= runIndent) break;
    body.push(l);
  }
  const strip = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return `${body.map((l) => l.slice(strip)).join('\n')}\n`;
};

const SHA = 'a'.repeat(40);
const runsFile = (name, json) => (temp) => {
  mkdirSync(dirname(join(temp, 'work/suites', name)), { recursive: true });
  writeFileSync(join(temp, 'work/suites', name), json);
};
const packed = (temp) => {
  const pkg = join(temp, 'tree/package');
  for (const f of ['dist/node.mjs', 'dist/jsh.mjs', 'dist/host/jsh.mjs', 'dist/host/main.mjs', 'NOTICE', 'package.json']) {
    mkdirSync(dirname(join(pkg, f)), { recursive: true });
    writeFileSync(join(pkg, f), '{}');
  }
  execFileSync('tar', ['-czf', join(temp, 'ai-ecoverse-slicc-jsh-1.2.3.tgz'), '-C', join(temp, 'tree'), 'package']);
};
const SUM = 'b'.repeat(64);
const GATES0 = [
  { file: 'ci.yml', job: 'ci', step: 'NOTICE covers', calls: /node -e/, says: [['packagesFromMetafiles', 'NOTICE ok: 12 packages']] },
  { file: 'ci.yml', job: 'ci', step: 'Lint', calls: /npm run lint/, says: [['run lint', 'lint ok']] },
  { file: 'ci.yml', job: 'ci', step: 'Golden', calls: /npm run test:golden/, says: [['test:golden', 'golden check: 161 fixture(s)']] },
  { file: 'ci.yml', job: 'ci', step: 'jsh parity', calls: /npm run test:jsh/, says: [['test:jsh', 'jsh check: 29 case(s)']] },
  { file: 'ci.yml', job: 'ci', step: 'Kernel integration', calls: /npm run test:integration/, says: [['test:integration', 'ℹ pass 300'], ['test:integration', 'ℹ fail 0']] },
  { file: 'ci.yml', job: 'ci', step: 'Cert (', calls: /npm run test:cert/, says: [['test:cert', 'cert: 4 suite(s), 195 case(s), failed=0']] },
  { file: 'ci.yml', job: 'ci', step: 'Node parallel', calls: /npm run test:node-parallel/, says: [['test:node-parallel', 'totals: PASS=134 FAIL=8 SKIP=0 of 142']] },
  { file: 'ci.yml', job: 'ci', step: 'Pack (files allowlist)', calls: /node -e "const p=JSON\.parse/, says: [['prepack', 'packed package.json: no prepare or prepack']], setup: packed },
  { file: 'ci.yml', job: 'install', step: 'install.sh', calls: /sh test\/install\/run\.sh/, says: [['run.sh', 'all install.sh cases passed']] },
  { file: 'ci.yml', job: 'browser', step: 'Browser suite', calls: /npm run test:browser/, says: [['test:browser', 'ℹ pass 62'], ['test:browser', 'ℹ fail 0']] },
  {
    file: 'cert-review.yml',
    job: 'scope',
    step: 'Shipped behaviour',
    calls: /scripts\/cert-review\/shipped\.mjs/,
    says: [['shipped.mjs', 'shipped: not behaviour: not behaviour: no shipped file changed (2 file(s): tests, docs, CI)']],
    output: 'behaviour=false',
  },
  {
    file: 'cert-review.yml',
    job: 'scope',
    step: 'Pack the candidate',
    calls: /scripts\/cert-review\/pack\.mjs/,
    says: [['pack.mjs', `pack: x.tgz sha256=${SUM} from ${SHA} (${SHA})`]],
  },
  {
    file: 'cert-review.yml',
    job: 'plan',
    step: 'The delta and the plan',
    calls: /scripts\/cert-review\/plan\.mjs/,
    setup: (temp) => {
      mkdirSync(join(temp, 'plan'));
      writeFileSync(join(temp, 'plan/plan.md'), 'the plan\n');
    },
    says: [['plan.mjs', 'plan: @ai-ecoverse/slicc-jsh@0.0.0-pr.7 from 0.0.0-base.7 (base), 3 commit(s), 1 PR(s), 4 file(s)']] },
  { file: 'cert-review.yml', job: 'bench', step: 'Stage the head', calls: /scripts\/cert-review\/stage\.mjs/, says: [['stage.mjs', `stage: @ai-ecoverse/slicc-jsh@0.0.0-pr.7 ${SUM} (prev 0.0.0-base.7), kernels new=1.119.2`]] },
  { file: 'cert-review.yml', job: 'bench', step: 'Suites on one tree', calls: /scripts\/cert-review\/suites\.mjs/, says: [['suites.mjs', 'suites new tag: 5 run(s) in runs-tag.json']] },
  {
    file: 'cert-review.yml',
    job: 'bench',
    step: 'Suites on one tree',
    calls: /scripts\/cert-review\/suites\.mjs/,
    variant: 'an alias of another kernel',
    says: [['suites.mjs', 'suites: kernel new is 1.119.2, the same as dev: nothing to run']],
  },
  {
    file: 'cert-review.yml',
    job: 'bench',
    step: 'Suites on one tree',
    calls: /scripts\/cert-review\/suites\.mjs/,
    variant: "main's suites.mjs before its verdict line: its runs file",
    says: [],
    setup: runsFile('new/runs-tag.json', '[{"suite":"golden"}]'),
    silentSetup: runsFile('new/runs-tag.json', '[]'),
  },
  { file: 'cert-review.yml', job: 'bench', step: 'm-fixtures and rows', calls: /scripts\/cert-review\/mfixtures\.mjs/, says: [['mfixtures.mjs', 'mfixtures new: {"same":469}']] },
  {
    file: 'cert-review.yml',
    job: 'bench',
    step: 'Browser suite on the head',
    calls: /scripts\/cert-review\/suites\.mjs .*--only browser --tree both/,
    says: [['suites.mjs', 'suites new (1.124.12) browser.json: regression 0, fixed 1, both-fail 0, fail-new-only 0']],
    partial: [['suites.mjs', 'suites new browser: 1 run(s) in runs-browser.json']],
  },
  {
    file: 'cert-review.yml',
    job: 'review',
    step: 'Stage the trees',
    calls: /scripts\/cert-review\/(stage\.mjs|suites\.mjs --work "\$WORK" --kernel "\$k" --merge)/,
    says: [
      ['stage.mjs', `stage: @ai-ecoverse/slicc-jsh@0.0.0-pr.7 ${SUM} (prev 0.0.0-base.7), kernels new=1.119.2`],
      ['--merge', 'suites new (1.119.2) suites.json: regression 0, fixed 1, both-fail 8, fail-new-only 0'],
    ],
    partial: [['stage.mjs', `stage: @ai-ecoverse/slicc-jsh@0.0.0-pr.7 ${SUM} (prev 0.0.0-base.7), kernels new=1.119.2`]],
  },
  {
    file: 'cert-review.yml',
    job: 'record',
    step: 'The line',
    calls: /scripts\/cert-review\/record\.mjs/,
    env: { BEHAVIOUR: 'true' },
    says: (temp) => realRecord(temp),
    failsAs: 'verdict=fail',
    passesAs: 'verdict=certified',
  },
  { file: 'cert-review.yml', job: 'merge-group', step: 'Every pull request in the group', calls: /scripts\/cert-review\/group\.mjs/, says: () => realGroup() },
  { file: 'release.yml', job: 'tag', step: 'The tag job fails', calls: /scripts\/release-outcome\.mjs/, variant: 'nothing to release', says: () => realOutcome([]) },
  { file: 'release.yml', job: 'tag', step: 'The tag job fails', calls: /scripts\/release-outcome\.mjs/, variant: 'one tag', says: () => realOutcome(['v1.2.3']) },
  { file: 'release.yml', job: 'tag', step: 'The tag job fails', calls: /scripts\/release-outcome\.mjs/, variant: 'two tags', says: () => realOutcome(['v1.2.3', 'v1.3.0']) },
  {
    file: 'release.yml',
    job: 'notes',
    step: 'The cert-review section',
    calls: /scripts\/cert-review\/carry\.mjs/,
    says: () => [['tag --list', 'v1.2.2'], ['tag --list', 'v1.2.3'], ...realCarry()],
    partial: [['tag --list', 'v1.2.2'], ['tag --list', 'v1.2.3']],
  },
];


const evidenceSays = [['--input-type=module', 'evidence: 1 artifact(s) by id: 101']];
const EVIDENCE_GATES = [
  ['bench', 'The pack artifact, by the id'],
  ['review', 'The bench artifacts, exactly those'],
  ['review', 'The plan artifact, by the id'],
  ['review', 'The pack artifact, by the id'],
  ['record', 'The verdict artifact, by the id'],
  ['record', 'The pack artifact, by the id'],
].map(([job, step]) => ({ file: 'cert-review.yml', job, step, calls: /node --input-type=module -e "\$EVIDENCE_CHECK"/, says: evidenceSays }));

const GATES = [...GATES0, ...EVIDENCE_GATES];

const NOT_GATES = [
  [/npm run build/, 'the build: every gated step after it uses its output'],
  [/npm run browser\b/, "Chrome for Testing's install: the browser suite that needs it is gated"],
  [/scripts\/strip-pack-scripts\.mjs/, "a transform of the tarball: the pack step's own checks of the listing follow it"],
  [/scripts\/cert-review\/digest\.mjs/, "the reviewer's input: the review gates on its verdict.json"],
  [/scripts\/cert-review\/prompt\.mjs/, "the reviewer's instructions: the review gates on its verdict.json"],
];

const scratch = mkdtempSync(join(tmpdir(), 'slicc-jsh-gate-verdicts-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const bin = join(scratch, 'bin');
mkdirSync(bin);
const STUB = `#!/bin/sh
args="$*"
case "$args" in *"--notes-file -"*) cat > /dev/null ;; esac
out=
if [ -n "$STUB_RULES" ]; then
  while IFS='\t' read -r pat line; do
    case "$args" in *"$pat"*) out="$out$line
"
      [ -n "$STUB_FIRST" ] && break ;; esac
  done < "$STUB_RULES"
fi
printf '%s' "$out"
[ -n "$STUB_OUTPUT" ] && [ -n "$out" ] && printf '%s\\n' "$STUB_OUTPUT" >> "$GITHUB_OUTPUT"
[ -n "$STUB_WRITE" ] && [ -n "$out" ] && printf '%s' "$out" > "$STUB_WRITE"
exit 0
`;
for (const tool of ['node', 'npm', 'npx', 'gh', 'git', 'sh', 'setsid', 'claude']) {
  writeFileSync(join(bin, tool), STUB);
  chmodSync(join(bin, tool), 0o755);
}

let runs = 0;
let reals = 0;
const real = (script, args, { cwd = root, stub = [], rules = [], env = {}, imports } = {}) => {
  const dir = join(scratch, `real-${++reals}`);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  for (const tool of stub) {
    writeFileSync(join(dir, 'bin', tool), STUB);
    chmodSync(join(dir, 'bin', tool), 0o755);
  }
  writeFileSync(join(dir, 'rules.tsv'), rules.map(([pat, line]) => `${pat}\t${line}\n`).join(''));
  const e = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, STUB_RULES: join(dir, 'rules.tsv'), STUB_FIRST: '1', STUB_OUTPUT: '', STUB_WRITE: '', GH_TOKEN: '', GITHUB_TOKEN: '', ...env };
  for (const k of ['NODE_TEST_CONTEXT', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY', 'GITHUB_REPOSITORY']) delete e[k];
  const r = spawnSync(process.execPath, [...(imports ? ['--import', imports] : []), join(root, script), ...args], { cwd, encoding: 'utf8', env: e, timeout: 60_000 });
  assert.equal(r.status, 0, `${script} ${args.join(' ')}: exit ${r.status}\n${r.stdout}${r.stderr}`);
  return r.stdout;
};
const said = (pattern, stdout) =>
  stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => [pattern, line]);

const gitIn = (dir, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' }).trim();
let repos = 0;
const scratchRepo = () => {
  const dir = join(scratch, `repo-${++repos}`);
  mkdirSync(dir);
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'commit', '-q', '--allow-empty', '-m', 'one');
  gitIn(dir, 'tag', 'v1.2.2');
  const base = gitIn(dir, 'rev-parse', 'HEAD');
  gitIn(dir, 'checkout', '-q', '-b', 'change');
  gitIn(dir, 'commit', '-q', '--allow-empty', '-m', 'fix: a change');
  const head = gitIn(dir, 'rev-parse', 'HEAD');
  gitIn(dir, 'checkout', '-q', 'main');
  gitIn(dir, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #7 from o/change', 'change');
  gitIn(dir, 'tag', 'v1.2.3');
  return { dir, base, head, merge: gitIn(dir, 'rev-parse', 'HEAD') };
};

const realOutcome = (tags) => {
  const dir = join(scratch, `outcome-${++repos}`);
  mkdirSync(dir);
  gitIn(dir, 'init', '-q');
  gitIn(dir, 'commit', '-q', '--allow-empty', '-m', 'one');
  for (const t of tags) gitIn(dir, 'tag', t);
  return said('release-outcome.mjs', real('scripts/release-outcome.mjs', [], { cwd: dir, env: { SEMANTIC_RELEASE: 'success' } }));
};

const NOTES = `the notes ${'x'.repeat(96 * 1024)}`;
const certifiedAt = (head) => `certified @ai-ecoverse/slicc-jsh PR #7 head ${head} sha256=${SUM} (ci: run; known: none; not covered: bios real setup (manual))`;

const realGroup = () => {
  const r = scratchRepo();
  const statuses = join(scratch, `statuses-${repos}.json`);
  writeFileSync(statuses, JSON.stringify({ [r.head]: { state: 'success', description: certifiedAt(r.head) } }));
  return said('group.mjs', real('scripts/cert-review/group.mjs', ['--base', r.base, '--head', r.merge, '--dir', r.dir, '--statuses', statuses, '--dry-run']));
};

const realCarry = () => {
  const r = scratchRepo();
  const status = JSON.stringify([{ context: 'cert-review', state: 'success', description: certifiedAt(r.head), target_url: 'run' }]);
  const rules = [
    ['statuses', status],
    ['pulls/7', '{"title":"fix: a change"}'],
    ['release view', NOTES],
    ['release edit', ''],
  ];
  return said('carry.mjs', real('scripts/cert-review/carry.mjs', ['--from', 'v1.2.2', '--to', 'v1.2.3', '--release', 'v1.2.3', '--dir', r.dir, '--repo', 'o/r'], { stub: ['gh'], rules }));
};

const realRecord = (temp) => {
  const src = join(temp, 'record-src');
  mkdirSync(join(src, 'package/dist'), { recursive: true });
  writeFileSync(join(src, 'package/package.json'), JSON.stringify({ name: '@ai-ecoverse/slicc-jsh', version: '0.0.0-pr.7', gitHead: SHA }));
  writeFileSync(join(src, 'package/dist/node.mjs'), 'export {};\n');
  const tgz = join(temp, 'record-src.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', src, 'package/package.json', 'package/dist/node.mjs']);
  const sum = createHash('sha256').update(readFileSync(tgz)).digest('hex');
  writeFileSync(join(temp, 'cert-review/verdict.json'), '{"verdict":"certified","known":[]}');
  const args = ['--pr', '7', '--head', SHA, '--commit', SHA, '--version', '0.0.0-pr.7', '--review', join(temp, 'cert-review'), '--out', join(temp, 'record'), '--run', 'run', '--repo', 'o/r', '--tarball', tgz, '--sha256', sum, '--upstream', 'success'];
  return said('record.mjs', real('scripts/cert-review/record.mjs', args));
};

const runStep = (script, { says = [], env = {}, writes, output, setup, stubs = true } = {}) => {
  const dir = join(scratch, `run-${++runs}`);
  const temp = join(dir, 'temp');
  for (const d of ['pack/pack/head', 'pack/pack/base', 'pack/head', 'pack/base', 'record', 'cert-review', 'work']) mkdirSync(join(temp, d), { recursive: true });
  for (const d of ['head', 'base']) {
    writeFileSync(join(temp, 'pack/pack', d, 'x.tgz'), '');
    writeFileSync(join(temp, 'pack', d, 'pack.json'), `{"sha256":"${SUM}"}`);
  }
  writeFileSync(join(temp, 'work/stage.json'), '{"kernels":[{"id":"new"}]}');
  setup?.(temp);
  const said = typeof says === 'function' ? says(temp) : says;
  const rules = join(dir, 'rules.tsv');
  writeFileSync(rules, said.map(([pat, line]) => `${pat}\t${line}\n`).join(''));
  const outputs = join(dir, 'output');
  writeFileSync(outputs, '');
  const file = join(dir, 'step.sh');
  writeFileSync(file, script.replaceAll('${{ matrix.kernel }}', 'new'));
  assert.doesNotMatch(script.replaceAll('${{ matrix.kernel }}', ''), /\$\{\{/, 'an expression left in the step');
  const r = spawnSync('bash', ['--noprofile', '--norc', '-e', file], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: stubs ? `${bin}:${process.env.PATH}` : `${dirname(process.execPath)}:${process.env.PATH}`,
      HOME: dir,
      RUNNER_TEMP: temp,
      GITHUB_OUTPUT: outputs,
      GITHUB_ENV: join(dir, 'env'),
      GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      GITHUB_WORKSPACE: dir,
      STUB_RULES: rules,
      STUB_OUTPUT: output ?? '',
      STUB_WRITE: writes ? join(temp, writes) : '',
      ISOLATE: '',
      WORK: join(temp, 'work'),
      TREE: 'tag',
      SHARD: '1/2',
      N: '7',
      HEAD_SHA: SHA,
      CANDIDATE: SHA,
      BASE: SHA,
      VERSION: '1.2.3',
      PREV: '1.2.2',
      BEHAVIOUR: 'true',
      WHY: '',
      PACKED: SUM,
      UPSTREAM: 'success',
      RUN_URL: 'run',
      GH_REPO: 'o/r',
      SEMANTIC_RELEASE: 'success',
      EVIDENCE: 'success',
      PACK: '',
      PLAN: '',
      VERDICT_ARTIFACT: '',
      BENCH: '{}',
      STRICT: 'true',
      LEGS: '',
      EVIDENCE_CHECK: 'unused: node is stubbed',
      ...env,
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, outputs: readFileSync(outputs, 'utf8') };
};

const label = (g) => `${g.file} ${g.job} "${g.step}"${g.variant ? ` (${g.variant})` : ''}`;

describe("a gate's silence is never a pass: the wiring", () => {
  for (const g of GATES) {
    it(`${label(g)} runs its gate and fails without the verdict line`, () => {
      const run = runOf(g.file, g.job, g.step);
      assert.match(run, g.calls);
      assert.match(run, /grep -Eq /);
      assert.match(run, /: no verdict::/);
      assert.match(run, /a gate's silence is not a pass/);
    });
  }

  it('every script, suite or check a workflow step runs is a gate here or named as not one', () => {
    const calls = /(?<![\w.-])(?:node (?:scripts|test)\/\S+|node -e|node --input-type=module -e|npm run [\w:-]+|sh test\/\S+)/g;
    for (const file of WORKFLOWS) {
      for (const line of text[file].split('\n')) {
        for (const [call] of line.matchAll(calls)) {
          if (NOT_GATES.some(([re]) => re.test(call))) continue;
          const gated = GATES.some((g) => g.file === file && g.calls.test(line) && runOf(g.file, g.job, g.step).includes(line.trim()));
          assert.ok(gated, `${file}: "${call}" (${line.trim().slice(0, 100)}) is neither a gate nor named as not one`);
        }
      }
    }
  });
});

describe("a gate's silence is never a pass: the steps, with the gate exiting 0", () => {
  for (const g of GATES) {
    it(`${label(g)}: silent, it fails the step`, () => {
      const r = runStep(runOf(g.file, g.job, g.step), { env: g.env, writes: g.writes, setup: g.silentSetup ?? (g.says.length !== 0 ? g.setup : undefined) });
      assert.match(r.out, /: no verdict::/, r.out);
      if (g.failsAs) assert.match(r.outputs, new RegExp(`^${g.failsAs}$`, 'm'), r.out);
      else assert.notEqual(r.code, 0, r.out);
    });

    if (g.partial) {
      it(`${label(g)}: with only some of its verdict lines, it fails the step`, () => {
        const r = runStep(runOf(g.file, g.job, g.step), { says: g.partial, env: g.env, writes: g.writes, setup: g.setup });
        assert.notEqual(r.code, 0, r.out);
        assert.match(r.out, /: no verdict::/, r.out);
      });
    }

    it(`${label(g)}: with its verdict line, it passes`, () => {
      const r = runStep(runOf(g.file, g.job, g.step), { says: g.says, env: g.env, writes: g.writes, output: g.output, setup: g.setup });
      assert.equal(r.code, 0, r.out);
      assert.doesNotMatch(r.out, /no verdict/, r.out);
      if (g.passesAs) assert.match(r.outputs, new RegExp(`^${g.passesAs}$`, 'm'), r.out);
    });
  }

  it('shipped.mjs printing its line but no behaviour output fails the scope step', () => {
    const g = GATES.find((x) => x.job === 'scope' && x.step.startsWith('Shipped'));
    const r = runStep(runOf(g.file, g.job, g.step), { says: g.says });
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /scope: no verdict::/, r.out);
  });

  it('record.mjs exiting 0 with a certified line for another head records a failure', () => {
    const r = runStep(runOf('cert-review.yml', 'record', 'The line'), {
      says: [['record.mjs', `certified @ai-ecoverse/slicc-jsh PR #7 head ${'c'.repeat(40)} sha256=${SUM} (ci: run)`]],
      writes: 'record/line.txt',
    });
    assert.match(r.outputs, /^verdict=fail$/m, r.out);
    assert.match(r.outputs, /^state=failure$/m, r.out);
  });

  it('the record step refuses a not-behaviour scope without its reason', () => {
    const run = runOf('cert-review.yml', 'record', 'The line');
    for (const env of [
      { BEHAVIOUR: '', WHY: '' },
      { BEHAVIOUR: 'false', WHY: '' },
      { BEHAVIOUR: 'false', WHY: 'no change' },
    ]) {
      const r = runStep(run, { env });
      assert.notEqual(r.code, 0, `${JSON.stringify(env)}: ${r.out}`);
      assert.doesNotMatch(r.outputs, /verdict=/, r.out);
    }
    const ok = runStep(run, { env: { BEHAVIOUR: 'false', WHY: 'not behaviour: no shipped file changed (1 file(s): tests, docs, CI)' } });
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.outputs, /^verdict=not-behaviour$/m, ok.out);
  });
});

describe("a gate's silence is never a pass: cert-review's required check", () => {
  const run = runOf('cert-review.yml', 'verdict', 'The required check');
  const verdict = (env) => runStep(run, { env: { EVENT: 'pull_request', GUARD: 'success', SCOPE: 'success', FORK: 'false', READY: 'false', VERDICT: '', GROUP: '', ...env } });
  const cases = [
    ['a scope without a behaviour verdict', { BEHAVIOUR: '' }, 1],
    ['not behaviour without its reason', { BEHAVIOUR: 'false', WHY: '', VERDICT: 'not-behaviour' }, 1],
    ['not behaviour with the record job silent', { BEHAVIOUR: 'false', WHY: 'not behaviour: no change', VERDICT: '' }, 1],
    ['not behaviour, recorded', { BEHAVIOUR: 'false', WHY: 'not behaviour: no change', VERDICT: 'not-behaviour' }, 0],
    ["a fork's not behaviour (no record job)", { FORK: 'true', BEHAVIOUR: 'false', WHY: 'not behaviour: no change', VERDICT: '' }, 0],
    ['behaviour, certified', { BEHAVIOUR: 'true', READY: 'true', VERDICT: 'certified' }, 0],
    ['behaviour, the record job silent', { BEHAVIOUR: 'true', READY: 'true', VERDICT: '' }, 1],
    ['behaviour on a draft, even with a certified verdict', { BEHAVIOUR: 'true', READY: 'false', VERDICT: 'certified' }, 1],
    ['behaviour with no ready value', { BEHAVIOUR: 'true', READY: '', VERDICT: 'certified' }, 1],
    ['a merge group, the group check passed', { EVENT: 'merge_group', SCOPE: '', BEHAVIOUR: '', GROUP: 'success' }, 0],
    ['a merge group, the group check skipped', { EVENT: 'merge_group', SCOPE: '', BEHAVIOUR: '', GROUP: 'skipped' }, 1],
  ];
  for (const [what, env, code] of cases) {
    it(`${what}: exit ${code}`, () => {
      const r = verdict(env);
      assert.equal(r.code, code, r.out);
    });
  }
  it('a draft is red with its reason, and readiness is the draft flag, never a label', () => {
    const r = verdict({ BEHAVIOUR: 'true', WHY: 'behaviour: src/a.ts', READY: 'false', VERDICT: '' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /cert-review: draft, not reviewed::this pull request changes shipped behaviour \(behaviour: src\/a\.ts\) and is a draft/);
    assert.match(text['cert-review.yml'], /READY: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.draft == false \}\}/);
    assert.doesNotMatch(text['cert-review.yml'], /merge-ok/);
    assert.match(text['ci.yml'], /types: \[opened, synchronize, reopened, ready_for_review, converted_to_draft, labeled, unlabeled\]/);
    assert.match(text['ci.yml'], /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  });
});

const EVIDENCE_CHECK = (() => {
  const lines = text['cert-review.yml'].split('\n');
  const at = lines.indexOf('  EVIDENCE_CHECK: |');
  assert.ok(at >= 0, 'cert-review.yml: no EVIDENCE_CHECK');
  const body = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() && !l.startsWith('    ')) break;
    body.push(l.slice(4));
  }
  return `${body.join('\n')}\n`;
})();

const LEGS = [...['new', 'dev', '186', 'floor'].flatMap((k) => ['suites-tag', 'suites-neg', 'fixtures-1', 'fixtures-2'].map((p) => `${p}-${k}`)), 'browser-dev'];
const STARTED = '2026-10-17T12:00:00Z';
const BEFORE = '2026-10-17T11:00:00Z';
const AFTER = '2026-10-17T12:30:00Z';
const digestOf = (id) => createHash('sha256').update(String(id)).digest('hex');
const benchRun = () => {
  const outputs = {};
  const artifacts = [];
  LEGS.forEach((leg, i) => {
    const id = 1000 + i;
    outputs[leg] = `${id} ${digestOf(id)}`;
    artifacts.push({ id, name: `cert-bench-7-${leg}`, digest: `sha256:${digestOf(id)}`, created_at: AFTER });
  });
  return { outputs, artifacts };
};

let mocks = 0;
const evidenceStep = (job, step, { artifacts, env = {} }) => {
  const dir = join(scratch, `evidence-${++mocks}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ run_started_at: STARTED }));
  writeFileSync(join(dir, 'artifacts.json'), JSON.stringify({ total_count: artifacts.length, artifacts }));
  const mock = join(dir, 'fetch.mjs');
  writeFileSync(
    mock,
    `import { readFileSync } from 'node:fs';
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (!u.pathname.startsWith('/repos/o/r/actions/runs/42')) return new Response('', { status: 404 });
  const file = u.pathname.endsWith('/artifacts') ? (u.searchParams.get('page') === '1' ? 'artifacts.json' : null) : 'run.json';
  return new Response(file ? readFileSync(${JSON.stringify(dir)} + '/' + file) : '{"artifacts":[]}');
};
`
  );
  return runStep(runOf('cert-review.yml', job, step), {
    stubs: false,
    env: { EVIDENCE_CHECK, NODE_OPTIONS: `--import ${pathToFileURL(mock).href}`, GITHUB_API_URL: 'https://api.example', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '42', GH_TOKEN: 't', ...env },
  });
};

describe('cert-review evidence: a consumer reads only the artifacts its producer jobs reported, by id and digest', () => {
  const review = (artifacts, outputs, strict = 'true') => evidenceStep('review', 'The bench artifacts, exactly those', { artifacts, env: { BENCH: JSON.stringify(outputs), STRICT: strict, LEGS: LEGS.join(' ') } });
  const idsOf = (r) => /^ids=(.*)$/m.exec(r.outputs)?.[1];

  it('the bench artifacts the bench jobs reported: the review downloads exactly those ids', () => {
    const { outputs, artifacts } = benchRun();
    const r = review(artifacts, outputs);
    assert.equal(r.code, 0, r.out);
    assert.equal(idsOf(r), artifacts.map((a) => a.id).join(','), r.out);
    assert.match(r.out, /^evidence: 17 artifact\(s\) by id: /m);
  });

  it('a planted extra artifact matching the bench pattern fails the review', () => {
    const { outputs, artifacts } = benchRun();
    const r = review([...artifacts, { id: 9999, name: 'cert-bench-7-suites-tag-evil', digest: `sha256:${digestOf(9999)}`, created_at: AFTER }], outputs);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /cert-bench-7-suites-tag-evil \(id 9999\): no job of this run reported it/);
    assert.equal(idsOf(r), undefined);
  });

  it("an artifact whose digest is not the one its job reported fails the review", () => {
    const { outputs, artifacts } = benchRun();
    artifacts[3].digest = `sha256:${'0'.repeat(64)}`;
    const r = review(artifacts, outputs);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /cert-bench-7-fixtures-2-new: its job uploaded digest [0-9a-f]{64}, the run's id 1003 has 0{64}/);
  });

  it('a second artifact under a leg’s name in this attempt (a re-upload after the job’s) fails the review', () => {
    const { outputs, artifacts } = benchRun();
    const r = review([...artifacts, { id: 5000, name: 'cert-bench-7-suites-tag-new', digest: `sha256:${digestOf(5000)}`, created_at: AFTER }], outputs);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /cert-bench-7-suites-tag-new: the run has id 5000, which its job did not upload/);
  });

  it("an earlier attempt's artifact under a leg's name is ignored (a re-run of failed jobs)", () => {
    const { outputs, artifacts } = benchRun();
    const r = review([{ id: 500, name: 'cert-bench-7-suites-tag-new', digest: `sha256:${digestOf(500)}`, created_at: BEFORE }, ...artifacts], outputs);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(idsOf(r), /\b500\b/);
  });

  it('a leg that uploaded nothing, with an artifact under its name, fails the review', () => {
    const { outputs, artifacts } = benchRun();
    outputs['browser-dev'] = 'none none';
    const r = review(artifacts, outputs);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /cert-bench-7-browser-dev: the run has id 1016, which its job did not upload/);
  });

  it('after a successful bench, a leg with no report fails the review; after a failed bench, its artifact is left out', () => {
    const { outputs, artifacts } = benchRun();
    delete outputs['suites-neg-floor'];
    const strict = review(artifacts, outputs);
    assert.equal(strict.code, 1, strict.out);
    assert.match(strict.out, /cert-bench-7-suites-neg-floor: its job reported no artifact/);
    const loose = review(artifacts, outputs, 'false');
    assert.equal(loose.code, 0, loose.out);
    assert.doesNotMatch(idsOf(loose), /\b1013\b/);
    assert.match(loose.out, /^evidence: 16 artifact\(s\) by id: /m);
  });

  it('the record: a planted second verdict artifact or a digest mismatch fails its evidence step, and the record then fails the pull request', () => {
    const verdict = { id: 77, name: 'cert-review-verdict-7', digest: `sha256:${digestOf(77)}`, created_at: AFTER };
    const step = (artifacts, reported) => evidenceStep('record', 'The verdict artifact, by the id', { artifacts, env: { VERDICT_ARTIFACT: reported } });
    const ok = step([verdict], `77 ${digestOf(77)}`);
    assert.equal(ok.code, 0, ok.out);
    assert.equal(idsOf(ok), '77');
    const planted = step([verdict, { ...verdict, id: 78, digest: `sha256:${digestOf(78)}` }], `77 ${digestOf(77)}`);
    assert.equal(planted.code, 1, planted.out);
    assert.match(planted.out, /cert-review-verdict-7: the run has id 78, which its job did not upload/);
    const forged = step([{ ...verdict, digest: `sha256:${digestOf(1)}` }], `77 ${digestOf(77)}`);
    assert.equal(forged.code, 1, forged.out);
    const r = runStep(runOf('cert-review.yml', 'record', 'The line'), { env: { BEHAVIOUR: 'true', EVIDENCE: 'failure' } });
    assert.equal(r.code, 0, r.out);
    assert.match(r.outputs, /^verdict=fail$/m);
    assert.match(r.outputs, /^state=failure$/m);
    assert.doesNotMatch(r.out, /record\.mjs/);
  });

  it('the producers report what they uploaded: the upload ids and digests are job outputs, one per bench leg', () => {
    const y = text['cert-review.yml'];
    assert.match(y, /pack_artifact: \$\{\{ steps\.pack-artifact\.outputs\.artifact-id && format\('\{0\} \{1\}', steps\.pack-artifact\.outputs\.artifact-id, steps\.pack-artifact\.outputs\.artifact-digest\) \|\| '' \}\}/);
    assert.match(y, /plan_artifact: \$\{\{ steps\.plan-artifact\.outputs\.artifact-id/);
    assert.match(y, /verdict_artifact: \$\{\{ steps\.verdict-artifact\.outputs\.artifact-id/);
    for (const leg of LEGS) assert.match(y, new RegExp(`\\n      ${leg}: \\$\\{\\{ steps\\.leg\\.outputs\\.${leg} \\}\\}\\n`), leg);
    assert.match(runOf('cert-review.yml', 'bench', "The evidence artifact's id and digest"), /echo "\$KEY=\$\{ID:-none\} \$\{DIGEST:-none\}"/);
    assert.match(y, /LEGS: (\S+ ){16}\S+\n/);
    assert.equal(/LEGS: (.*)\n/.exec(y)[1], LEGS.join(' '));
  });

  it('no consumer downloads by name or pattern: every download-artifact is by the ids an evidence step checked', () => {
    const y = text['cert-review.yml'];
    const downloads = y.split('- uses: actions/download-artifact@').slice(1).map((d) => d.split('\n      - ')[0]);
    assert.equal(downloads.length, 6);
    for (const d of downloads) {
      assert.doesNotMatch(d, /\n\s+(name|pattern):/, d);
      assert.match(d, /artifact-ids: \$\{\{ steps\.[\w-]+-evidence\.outputs\.ids \}\}/, d);
      assert.match(d, /if: .*steps\.[\w-]+-evidence\.outputs\.ids != ''/, d);
    }
  });
});
