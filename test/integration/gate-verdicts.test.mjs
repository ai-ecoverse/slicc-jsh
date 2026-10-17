import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

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
const GATES = [
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
  { file: 'cert-review.yml', job: 'bench', step: 'Browser suite on the head', calls: /scripts\/cert-review\/suites\.mjs/, says: [['suites.mjs', 'suites dev browser: 1 run(s) in runs-browser.json']] },
  {
    file: 'cert-review.yml',
    job: 'bench',
    step: 'Browser suite on the head',
    calls: /scripts\/cert-review\/suites\.mjs/,
    variant: "main's suites.mjs before its verdict line: its runs file",
    says: [],
    setup: runsFile('new/runs-browser.json', '[{"suite":"browser"}]'),
    silentSetup: runsFile('new/runs-browser.json', '[]'),
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
    says: [['record.mjs', `certified @ai-ecoverse/slicc-jsh PR #7 head ${SHA} sha256=${SUM} (ci: run; known: none; not covered: bios)`]],
    writes: 'record/line.txt',
    failsAs: 'verdict=fail',
    passesAs: 'verdict=certified',
  },
  { file: 'cert-review.yml', job: 'merge-group', step: 'Every pull request in the group', calls: /scripts\/cert-review\/group\.mjs/, says: [['group.mjs', 'group status: success: #7 certified at aaaaaaaaaaaa']] },
  { file: 'release.yml', job: 'tag', step: 'The tag job fails', calls: /scripts\/release-outcome\.mjs/, says: [['release-outcome.mjs', 'semantic-release tagged v1.2.3']] },
  {
    file: 'release.yml',
    job: 'verify',
    step: 'npm integrity',
    calls: /scripts\/cert-review\/published\.mjs/,
    says: [['published.mjs', `verified @ai-ecoverse/slicc-jsh@1.2.3 sha256=${SUM} on npm (latest): sha512-x, provenance release.yml`]],
  },
  { file: 'release.yml', job: 'verify', step: 'The release line', calls: /scripts\/release-line\.mjs/, says: [['release-line.mjs', 'wrote the line into the v1.2.3 release']] },
  {
    file: 'release.yml',
    job: 'verify',
    step: 'The cert-review section',
    calls: /scripts\/cert-review\/carry\.mjs/,
    says: [
      ['versions --json', '["1.2.2","1.2.3"]'],
      ['carry.mjs', 'wrote the cert-review section of v1.2.3 (2 pull request(s))'],
    ],
    partial: [['versions --json', '["1.2.2","1.2.3"]']],
  },
];

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
out=
if [ -n "$STUB_RULES" ]; then
  while IFS='\t' read -r pat line; do
    case "$args" in *"$pat"*) out="$out$line
" ;; esac
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
const runStep = (script, { says = [], env = {}, writes, output, setup } = {}) => {
  const dir = join(scratch, `run-${++runs}`);
  const temp = join(dir, 'temp');
  for (const d of ['pack/pack/head', 'pack/pack/base', 'pack/head', 'pack/base', 'record', 'cert-review', 'work']) mkdirSync(join(temp, d), { recursive: true });
  for (const d of ['head', 'base']) {
    writeFileSync(join(temp, 'pack/pack', d, 'x.tgz'), '');
    writeFileSync(join(temp, 'pack', d, 'pack.json'), `{"sha256":"${SUM}"}`);
  }
  writeFileSync(join(temp, 'work/stage.json'), '{"kernels":[{"id":"new"}]}');
  setup?.(temp);
  const rules = join(dir, 'rules.tsv');
  writeFileSync(rules, says.map(([pat, line]) => `${pat}\t${line}\n`).join(''));
  const outputs = join(dir, 'output');
  writeFileSync(outputs, '');
  const file = join(dir, 'step.sh');
  writeFileSync(file, script.replaceAll('${{ matrix.kernel }}', 'new'));
  assert.doesNotMatch(script.replaceAll('${{ matrix.kernel }}', ''), /\$\{\{/, 'an expression left in the step');
  const r = spawnSync('bash', ['--noprofile', '--norc', '-e', file], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
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
    const calls = /(?<![\w.-])(?:node (?:scripts|test)\/\S+|node -e|npm run [\w:-]+|sh test\/\S+)/g;
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
      const r = runStep(runOf(g.file, g.job, g.step), { env: g.env, writes: g.writes, setup: g.silentSetup ?? (g.says.length ? g.setup : undefined) });
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
    ['a merge group, the group check passed', { EVENT: 'merge_group', SCOPE: '', BEHAVIOUR: '', GROUP: 'success' }, 0],
    ['a merge group, the group check skipped', { EVENT: 'merge_group', SCOPE: '', BEHAVIOUR: '', GROUP: 'skipped' }, 1],
  ];
  for (const [what, env, code] of cases) {
    it(`${what}: exit ${code}`, () => {
      const r = verdict(env);
      assert.equal(r.code, code, r.out);
    });
  }
});
