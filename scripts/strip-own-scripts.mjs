#!/usr/bin/env node
/**
 * Run at the end of `prepack`: drop `prepare` and `prepack` from this
 * checkout's package.json, so the tarball npm packs right after (npm re-reads
 * package.json once prepack is done) has no build scripts. Published installs
 * then do not warn about scripts that need the unpublished scripts/ dir.
 *
 * semantic-release publishes with a plain `npm publish` (the shared
 * node-release.yml), so this is how the registry tarball gets stripped; ci.yml
 * checks a plain `npm pack` the same way.
 *
 * It edits package.json in place, so it only acts in CI (GITHUB_ACTIONS=true,
 * a throwaway checkout) or when SLICC_JSH_STRIP_SCRIPTS=1 is set; a local
 * `npm pack` keeps the scripts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
if (process.env.GITHUB_ACTIONS !== 'true' && process.env.SLICC_JSH_STRIP_SCRIPTS !== '1') {
  console.log('strip-own-scripts: not in CI, keeping prepare/prepack');
  process.exit(0);
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
if (pkg.scripts) {
  delete pkg.scripts.prepare;
  delete pkg.scripts.prepack;
}
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log('strip-own-scripts: removed prepare/prepack from package.json for packing');
