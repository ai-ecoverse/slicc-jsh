/**
 * Rewrite package/package.json inside an npm pack tarball: drop prepare/prepack
 * so installs from the published package do not warn about missing scripts/.
 *
 * Preserves package/ and package.json mtimes (and thus the uncompressed tar
 * content hash) across CI certify and publish.yml rebuild strip passes.
 *
 * Usage: node scripts/strip-pack-scripts.mjs <file.tgz>
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tgz = process.argv[2];
if (!tgz) {
  console.error('usage: node scripts/strip-pack-scripts.mjs <file.tgz>');
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'slicc-jsh-strip-'));
try {
  execFileSync('tar', ['-xzf', tgz, '-C', dir], { stdio: 'inherit' });
  const pkgDir = join(dir, 'package');
  const pkgPath = join(pkgDir, 'package.json');
  // package.json keeps its archived header mtime on extract. The package/
  // directory does not: creating children during extract bumps it to "now".
  // Stamp both from the file's archived mtime so independently stripped packs
  // share the same uncompressed tar content hash (assert-certified --rebuilt).
  const archived = statSync(pkgPath);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.scripts) {
    delete pkg.scripts.prepare;
    delete pkg.scripts.prepack;
  }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  utimesSync(pkgPath, archived.atime, archived.mtime);
  utimesSync(pkgDir, archived.atime, archived.mtime);
  execFileSync('tar', ['-czf', tgz, '-C', dir, 'package'], { stdio: 'inherit' });
  console.log(`stripped prepare/prepack from ${tgz}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
