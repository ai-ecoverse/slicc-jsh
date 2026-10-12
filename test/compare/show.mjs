#!/usr/bin/env node
/**
 * Prints one recorded case on every system, for reading a row of the gap
 * report: node test/compare/show.mjs <case> [system…]
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [name, ...wanted] = process.argv.slice(2);
if (!name) {
  console.error('usage: show.mjs <case> [six|seven|jsh|node …]');
  process.exit(2);
}
const meta = JSON.parse(readFileSync(join(here, 'cases', name, 'case.json'), 'utf8'));
console.log(`# ${name}: ${meta.description ?? ''}`);
for (const system of wanted.length ? wanted : ['six', 'seven', 'jsh', 'node']) {
  const p = join(here, 'results', name, `${system}.json`);
  if (!existsSync(p)) continue;
  const r = JSON.parse(readFileSync(p, 'utf8'));
  console.log(`\n## ${system} (status ${r.status})${r.skipped ? ` skipped: ${r.skipped}` : ''}`);
  if (r.stdout) {
    const lines = r.stdout.split('\n');
    const text = r.stdoutSha256
      ? `${r.stdout}\n[${r.stdoutChars} chars, sha256 ${r.stdoutSha256}]\n`
      : lines.length > 60 ? `${lines.slice(0, 5).join('\n')}\n… ${lines.length - 5} more lines, ${r.stdout.length} chars in all\n` : r.stdout;
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  }
  if (r.stderr) {
    console.log('-- stderr --');
    process.stdout.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  }
}
