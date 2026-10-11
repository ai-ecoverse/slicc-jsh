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
  // Capture before rewrite: writing package.json bumps the directory mtime, and
  // a fresh `tar -czf … package` would otherwise embed "now" for package/.
  const prevFile = statSync(pkgPath);
  const prevDir = statSync(pkgDir);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.scripts) {
    delete pkg.scripts.prepare;
    delete pkg.scripts.prepack;
  }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  // npm-normalized archive timestamps must survive the rewrite (assert-certified
  // compares uncompressed tar SHA-256 between the certified and rebuilt packs).
  utimesSync(pkgPath, prevFile.atime, prevFile.mtime);
  utimesSync(pkgDir, prevDir.atime, prevDir.mtime);
  execFileSync('tar', ['-czf', tgz, '-C', dir, 'package'], { stdio: 'inherit' });
  console.log(`stripped prepare/prepack from ${tgz}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
