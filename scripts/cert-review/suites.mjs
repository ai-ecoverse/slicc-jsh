#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { guarded, readJson, root } from './lib.mjs';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const { values } = parseArgs({
  options: {
    work: { type: 'string' },
    kernel: { type: 'string' },
    touched: { type: 'string', default: '' },
    only: { type: 'string', default: '' },
    neg: { type: 'string', default: 'all' },
    tree: { type: 'string', default: 'both' },
    merge: { type: 'boolean', default: false },
  },
});
const work = resolve(values.work);
const stage = readJson(join(work, 'stage.json'));
const kernel = stage.kernels.find((k) => k.id === values.kernel || k.names.includes(values.kernel));
if (!kernel) throw new Error(`no staged kernel ${values.kernel}`);
if (kernel.id !== values.kernel && values.only !== 'browser' && !values.merge) {
  console.log(`suites: kernel ${values.kernel} is ${kernel.version}, the same as ${kernel.id}: nothing to run`);
  process.exit(0);
}
const out = join(work, 'suites', kernel.id);
mkdirSync(join(out, 'logs'), { recursive: true });
const touched = values.touched ? readFileSync(values.touched, 'utf8').split('\n').filter(Boolean) : [];
const reporter = join(root, 'scripts/cert-review/reporter.mjs');
const clean = { ...process.env };
for (const k of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'GH_TOKEN', 'GITHUB_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK']) delete clean[k];

function useKernel(tree) {
  rmSync(join(tree, 'node_modules'), { force: true });
  symlinkSync(kernel.modules, join(tree, 'node_modules'));
}

async function exec(label, tree, command, env = {}) {
  const log = join(out, 'logs', `${label.replace(/[^\w.@-]+/g, '_')}.log`);
  const started = Date.now();
  console.log(`suites: ${label}: (${tree}) ${command}`);
  const r = await guarded('sh', ['-c', command], { cwd: tree, env: { ...clean, ...env }, log, timeoutMs: 40 * 60_000 });
  const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`suites: ${label}: exit ${r.exit}, ${seconds}s, peak ${Math.round(r.peakKb / 1000)} MB${r.breach ? ` (killed: ${r.breach})` : ''}`);
  return { text, exit: r.exit, breach: r.breach, peakMb: Math.round(r.peakKb / 1000), seconds, log };
}

function script(tree, name) {
  return readJson(join(tree, 'package.json')).scripts?.[name];
}

function fixtureNames(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'case.json')))
    .map((d) => d.name)
    .sort();
}

function goldenParse(skipped) {
  return (text, units) => {
    const res = {};
    for (const u of units) {
      const e = esc(u);
      if (new RegExp(`^${e} \\[[\\w-]+\\]: |^${e}: (?!shim skipped)`, 'm').test(text)) res[u] = 'fail';
      else if (new RegExp(`^(skip )?${e}(: shim skipped| \\[kernel\\]: )`, 'm').test(text) && skipped) res[u] = 'skip';
      else res[u] = 'pass';
    }
    return res;
  };
}

function nodeTest(dir, scriptName, harness) {
  return {
    fixtures: (tree) =>
      readdirSync(join(tree, 'test', dir))
        .filter((f) => f.endsWith('.test.mjs'))
        .sort(),
    prefix: `test/${dir}/`,
    harness,
    command(tree, units, results) {
      const base = script(tree, scriptName);
      if (!base) return undefined;
      const files = (units ?? this.fixtures(tree)).map((f) => `test/${dir}/${f}`);
      return base
        .replace(
          '--test ',
          `--test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=${reporter} --test-reporter-destination=${results} `
        )
        .replace(`test/${dir}/*.test.mjs`, files.join(' '));
    },
    tests: true,
  };
}

const SUITES = {
  golden: {
    fixtures: (tree) => fixtureNames(join(tree, 'test/golden/fixtures')),
    prefix: 'test/golden/fixtures/',
    harness: ['scripts/golden.mjs', 'scripts/node22.mjs', 'test/integration/helpers.mjs'],
    command: (tree, units) => `${script(tree, 'test:golden')}${units ? ` ${units.join(' ')}` : ''}`,
    parse: goldenParse(/: shim skipped/),
  },
  jsh: {
    fixtures: (tree) => fixtureNames(join(tree, 'test/jsh/fixtures')),
    prefix: 'test/jsh/fixtures/',
    harness: ['scripts/jsh-golden.mjs', 'scripts/node22.mjs', 'test/integration/helpers.mjs'],
    command: (tree, units) => `${script(tree, 'test:jsh')}${units ? ` ${units.join(' ')}` : ''}`,
    parse: goldenParse(/^skip /),
  },
  integration: nodeTest('integration', 'test:integration', ['test/integration/helpers.mjs', 'test/integration/fixture-npm.mjs', 'scripts/node22.mjs']),
  browser: nodeTest('browser', 'test:browser', ['test/browser/chrome.mjs', 'test/browser/kernel.mjs', 'test/browser/page/']),
  cert: {
    whole: true,
    harness: ['test/integration/cert/', 'test/integration/helpers.mjs', 'scripts/node22.mjs'],
    command: (tree) => script(tree, 'test:cert'),
    parse(text) {
      const res = {};
      for (const m of text.matchAll(/^# (?:M1-GAP )?(SAME|DIFF|FAIL|ERROR|TIMEOUT)\S* (.+?) \(\d+ ms\)$/gm)) {
        res[m[2]] = m[1] === 'SAME' ? 'pass' : 'fail';
      }
      return res;
    },
  },
  'node-parallel': {
    whole: true,
    harness: ['test/node-parallel/'],
    command: (tree) => script(tree, 'test:node-parallel'),
    parse(text) {
      const res = {};
      for (const m of text.matchAll(/^ {2}(PASS|FAIL|SKIP) (\S+)/gm)) res[m[2]] = m[1] === 'PASS' ? 'pass' : m[1] === 'SKIP' ? 'skip' : 'fail';
      return res;
    },
  },
};

async function runSuite(name, treeName, units) {
  const s = SUITES[name];
  const tree = stage.trees[treeName];
  if (!s.command(tree, null, '/dev/null')) return { suite: name, tree: treeName, missing: true, results: {} };
  const label = `${name}-${treeName}-${kernel.id}`;
  const results = join(out, `${label}.jsonl`);
  rmSync(results, { force: true });
  const r = await exec(label, tree, s.command(tree, units, results), { SLICC_CERT_KERNEL: kernel.version });
  let res = {};
  if (s.tests) {
    const counts = new Map();
    const lines = existsSync(results) ? readFileSync(results, 'utf8').split('\n').filter(Boolean) : [];
    for (const line of lines) {
      const t = JSON.parse(line);
      const key0 = `${basename(t.file ?? '?')} › ${t.name}`;
      const n = (counts.get(key0) ?? 0) + 1;
      counts.set(key0, n);
      res[n > 1 ? `${key0} #${n}` : key0] = t.status === 'todo' ? 'skip' : t.status;
    }
    for (const f of units ?? s.fixtures(tree)) {
      if (![...counts.keys()].some((k) => k.startsWith(`${f} › `))) res[`${f} › (file)`] = 'fail';
    }
  } else {
    res = s.parse(r.text, units ?? (s.fixtures ? s.fixtures(tree) : []));
    if (r.exit !== 0 && r.exit !== 1) {
      for (const [u, v] of Object.entries(res)) if (v === 'pass' && !new RegExp(`^ok ${esc(u)}$`, 'm').test(r.text)) res[u] = 'fail';
    }
  }
  if (r.exit !== 0 && !Object.values(res).includes('fail')) res['(suite exit)'] = 'fail';
  return { suite: name, tree: treeName, exit: r.exit, breach: r.breach, peakMb: r.peakMb, seconds: r.seconds, log: r.log, units: units ?? null, results: res };
}

function touches(s, unit) {
  if (values.neg === 'all') return true;
  if (touched.some((f) => s.harness.some((h) => f === h || (h.endsWith('/') && f.startsWith(h))))) return true;
  if (s.whole) return false;
  return touched.some((f) => f.startsWith(`${s.prefix}${unit}`) && (f.length === `${s.prefix}${unit}`.length || f[`${s.prefix}${unit}`.length] === '/' || s.tests));
}

function summarize(runs, name) {
  const matrix = {};
  for (const r of runs) {
    for (const [unit, status] of Object.entries(r.results)) {
      const key = `${r.suite} :: ${unit}`;
      matrix[key] ??= { suite: r.suite, unit, tag: null, neg: null };
      matrix[key][r.tree] = status;
    }
  }
  const classify = ({ tag, neg }) => {
    if (tag === 'fail' && neg === 'pass') return 'regression';
    if (tag === 'pass' && neg === 'fail') return 'fixed';
    if (tag === 'fail' && neg === 'fail') return 'both-fail';
    if (tag === 'fail' && neg === null) return 'fail-new-only';
    if (tag === 'fail' && neg === 'skip') return 'fail-neg-skipped';
    if (tag === 'pass' && neg === 'pass') return 'both-pass';
    if (tag === null && neg === 'fail') return 'neg-only';
    return tag ?? 'none';
  };
  const rows = Object.entries(matrix).map(([key, v]) => ({ key, ...v, class: classify(v) }));
  const pick = (...c) => rows.filter((r) => c.includes(r.class)).map((r) => r.key);
  const summary = {
    kernel: { id: kernel.id, names: kernel.names, version: kernel.version, users: 'enforce' },
    touched,
    runs: runs.map(({ results, ...r }) => ({ ...r, counts: Object.values(results).reduce((a, st) => ({ ...a, [st]: (a[st] ?? 0) + 1 }), {}) })),
    regression: pick('regression'),
    fixed: pick('fixed'),
    bothFail: pick('both-fail'),
    failNewOnly: pick('fail-new-only', 'fail-neg-skipped'),
    rows,
  };
  writeFileSync(join(out, name), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    `suites ${kernel.id} (${kernel.version}) ${name}: regression ${summary.regression.length}, fixed ${summary.fixed.length}, both-fail ${summary.bothFail.length}, fail-new-only ${summary.failNewOnly.length}`
  );
}

if (values.merge) {
  const runs = ['tag', 'neg'].flatMap((t) => (existsSync(join(out, `runs-${t}.json`)) ? readJson(join(out, `runs-${t}.json`)) : []));
  if (runs.length) summarize(runs, 'suites.json');
  else console.log(`suites ${kernel.id} (${kernel.version}): no runs to merge (no runs-tag.json or runs-neg.json)`);
  if (existsSync(join(out, 'runs-browser.json'))) summarize(readJson(join(out, 'runs-browser.json')), 'browser.json');
  process.exit(0);
}

useKernel(stage.trees.tag);
useKernel(stage.trees.neg);
const only = values.only ? values.only.split(',') : Object.keys(SUITES).filter((n) => n !== 'browser');
const trees = values.tree === 'both' ? ['tag', 'neg'] : [values.tree];
const runs = [];
for (const name of only) {
  const s = SUITES[name];
  let tag = null;
  if (trees.includes('tag')) {
    tag = await runSuite(name, 'tag', null);
    runs.push(tag);
    if (tag.missing) continue;
  }
  if (!trees.includes('neg')) continue;
  let negUnits = null;
  if (tag && values.neg !== 'all') {
    const notPass = new Set(
      Object.entries(tag.results)
        .filter(([, v]) => v === 'fail')
        .map(([k]) => k)
    );
    if (s.whole) negUnits = notPass.size || touches(s) ? null : [];
    else {
      negUnits = s.fixtures(stage.trees.tag).filter((u) => touches(s, u) || [...notPass].some((k) => k === u || k.startsWith(`${u} › `)));
      if (touches(s, '\u0000')) negUnits = null;
    }
  }
  if (negUnits && negUnits.length === 0) {
    runs.push({ suite: name, tree: 'neg', skipped: 'the delta touched none of its files and every one passed on tag', results: {} });
    continue;
  }
  runs.push(await runSuite(name, 'neg', negUnits));
}

const label = values.only === 'browser' ? 'browser' : null;
if (trees.length === 2) summarize(runs, label ? 'browser.json' : 'suites.json');
else {
  writeFileSync(join(out, `runs-${label ?? trees[0]}.json`), `${JSON.stringify(runs)}\n`);
  console.log(`suites ${kernel.id} ${label ?? trees[0]}: ${runs.length} run(s) in runs-${label ?? trees[0]}.json`);
}
