#!/usr/bin/env node
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readJson } from './lib.mjs';

const { values } = parseArgs({ options: { work: { type: 'string' } } });
const work = resolve(values.work);
const stage = readJson(join(work, 'stage.json'));
const list = (xs, n = 40) => (xs.length ? xs.slice(0, n).map((x) => `  - ${x}`).join('\n') + (xs.length > n ? `\n  - … ${xs.length - n} more` : '') : '  - none');
const lines = [`# Cert evidence: ${stage.name}@${stage.version} (from ${stage.prev})`, ''];
lines.push(`- published sha256 ${stage.published.sha256}`);
if (stage.rebuilt) lines.push(`- rebuild: tarball ${stage.rebuilt.reproducible ? 'identical' : `sha256 ${stage.rebuilt.sha256} differs`}; differing files: ${stage.rebuilt.differingFiles.join(', ') || 'none'}`);
lines.push(`- kernels: ${stage.kernels.map((k) => `${k.names.join('/')}=${k.version}`).join(', ')}`, '');
for (const k of stage.kernels) {
  for (const [file, title] of [
    ['suites.json', 'suites'],
    ['browser.json', 'browser'],
  ]) {
    const p = join(work, 'suites', k.id, file);
    if (!existsSync(p)) {
      if (file === 'suites.json') lines.push(`## suites, kernel ${k.id}: MISSING (no results)`, '');
      continue;
    }
    const s = readJson(p);
    lines.push(`## ${title}, kernel ${k.id} (${k.version}, users enforce)`, '');
    for (const r of s.runs) lines.push(`- ${r.suite} ${r.tree}: ${r.skipped ? `skipped (${r.skipped})` : `${JSON.stringify(r.counts)} exit ${r.exit}${r.breach ? ` KILLED ${r.breach}` : ''}, ${r.seconds}s, peak ${r.peakMb} MB${r.units ? `, units ${r.units.length}` : ''}`}`);
    lines.push(`- regression:\n${list(s.regression)}`, `- fixed (NEGATIVE holds):\n${list(s.fixed)}`, `- failed on tag, not run on neg:\n${list(s.failNewOnly)}`, `- both-fail: ${s.bothFail.length}`, '');
  }
  const fdir = join(work, 'fixtures', k.id);
  const parts = existsSync(fdir) ? readdirSync(fdir).filter((f) => /^summary(-\d+)?\.json$/.test(f)).sort() : [];
  if (parts.length) {
    const ss = parts.map((f) => readJson(join(fdir, f)));
    const cat = (field) => ss.flatMap((x) => x[field] ?? []);
    const counts = {};
    for (const x of ss) for (const [c, n] of Object.entries(x.counts)) counts[c] = (counts[c] ?? 0) + n;
    lines.push(`## m-fixtures, kernel ${k.id} (${k.version}, users enforce, as ${ss[0].kernel.user}; ${parts.join(', ')})`, '', `- counts: ${JSON.stringify(counts)}`);
    lines.push(
      `- regression (same on prev, diff on new):\n${list(cat('regression'))}`,
      `- fixed:\n${list(cat('fixed'))}`,
      `- flipped on the diagnostic re-runs (a flake to file, whatever its class):\n${list(cat('flipped'))}`,
      `- diff on both, output changed:\n${list(cat('diffChanged'))}`,
      `- rows whose output changed:\n${list(cat('rowChanged'), 80)}`,
      ''
    );
    const want = readdirSync(fdir).filter((f) => /^new(-\d+)?\.json$/.test(f)).length;
    if (want !== parts.length) lines.push(`- INCOMPLETE: ${want} result file(s), ${parts.length} summary file(s)`, '');
  } else if (existsSync(fdir)) {
    lines.push(`## m-fixtures, kernel ${k.id}: incomplete (${readdirSync(fdir).join(', ')})`, '');
  } else {
    lines.push(`## m-fixtures, kernel ${k.id}: MISSING (no results)`, '');
  }
}
const text = `${lines.join('\n')}\n`;
writeFileSync(join(work, 'digest.md'), text);
process.stdout.write(text);
