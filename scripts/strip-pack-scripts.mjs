/**
 * Rewrite package/package.json inside an npm pack tarball: drop prepare/prepack
 * so installs from the published package do not warn about missing scripts/.
 *
 * Re-stamps every archive entry (files and directories) to package.json's
 * archived mtime so a fresh pack + strip matches the CI artifact's
 * uncompressed tar content hash (publish.yml assert-certified --rebuilt).
 *
 * Usage: node scripts/strip-pack-scripts.mjs <file.tgz>
 */
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const tgz = process.argv[2];
if (!tgz) {
  console.error('usage: node scripts/strip-pack-scripts.mjs <file.tgz>');
  process.exit(2);
}

function stampTree(dir, atime, mtime) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) stampTree(path, atime, mtime);
    utimesSync(path, atime, mtime);
  }
  utimesSync(dir, atime, mtime);
}

const dir = mkdtempSync(join(tmpdir(), 'slicc-jsh-strip-'));
try {
  execFileSync('tar', ['-xzf', tgz, '-C', dir], { stdio: 'inherit' });
  const pkgDir = join(dir, 'package');
  const pkgPath = join(pkgDir, 'package.json');
  // package.json keeps its archived header mtime on extract. Stamp the whole
  // tree from that mtime so independently stripped packs share the same
  // uncompressed tar content hash (assert-certified --rebuilt).
  const archived = statSync(pkgPath);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.scripts) {
    delete pkg.scripts.prepare;
    delete pkg.scripts.prepack;
  }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  stampTree(pkgDir, archived.atime, archived.mtime);
  // Prefer GNU tar's deterministic order/owners when available so a fresh
  // strip can match CI's uncompressed tar content hash; fall back to host tar.
  try {
    const packed = execFileSync(
      'tar',
      [
        '-cf',
        '-',
        '--sort=name',
        '--owner=0',
        '--group=0',
        '--numeric-owner',
        '-C',
        dir,
        'package',
      ],
      { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    writeFileSync(tgz, gzipSync(packed, { level: 9 }));
  } catch {
    // macOS bsdtar lacks --sort=name; keep npm/host order.
    execFileSync('tar', ['-czf', tgz, '-C', dir, 'package'], { stdio: 'inherit' });
  }
  console.log(`stripped prepare/prepack from ${tgz}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
