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
    if (!existsSync(p)) continue;
    const s = readJson(p);
    lines.push(`## ${title}, kernel ${k.id} (${k.version}, users enforce)`, '');
    for (const r of s.runs) lines.push(`- ${r.suite} ${r.tree}: ${r.skipped ? `skipped (${r.skipped})` : `${JSON.stringify(r.counts)} exit ${r.exit}${r.breach ? ` KILLED ${r.breach}` : ''}, ${r.seconds}s, peak ${r.peakMb} MB${r.units ? `, units ${r.units.length}` : ''}`}`);
    lines.push(`- regression:\n${list(s.regression)}`, `- fixed (NEGATIVE holds):\n${list(s.fixed)}`, `- failed on tag, not run on neg:\n${list(s.failNewOnly)}`, `- both-fail: ${s.bothFail.length}`, '');
  }
  const f = join(work, 'fixtures', k.id, 'summary.json');
  if (existsSync(f)) {
    const s = readJson(f);
    lines.push(`## m-fixtures, kernel ${k.id} (${k.version}, users enforce, as ${s.kernel.user})`, '', `- counts: ${JSON.stringify(s.counts)}`);
    lines.push(`- regression (same on prev, diff on new):\n${list(s.regression)}`, `- fixed:\n${list(s.fixed)}`, `- diff on both, output changed:\n${list(s.diffChanged)}`, `- rows whose output changed:\n${list(s.rowChanged, 80)}`, '');
  } else if (existsSync(join(work, 'fixtures', k.id))) {
    lines.push(`## m-fixtures, kernel ${k.id}: incomplete (${readdirSync(join(work, 'fixtures', k.id)).join(', ')})`, '');
  }
}
const text = `${lines.join('\n')}\n`;
writeFileSync(join(work, 'digest.md'), text);
process.stdout.write(text);
