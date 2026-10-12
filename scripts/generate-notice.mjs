/**
 * Build NOTICE from esbuild metafiles: every bundled npm package gets its
 * LICENSE (or LICENSE.md / licence) text. Fails if a package has no license file.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));

const LICENSE_NAMES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENCE',
  'LICENCE.md',
  'license',
  'license.md',
];

function hasName(pkgJson) {
  try {
    return typeof JSON.parse(readFileSync(pkgJson, 'utf8')).name === 'string';
  } catch {
    return false;
  }
}

function findPackageRoot(filePath) {
  let dir = dirname(filePath);
  for (let i = 0; i < 40; i++) {
    const pkg = join(dir, 'package.json');
    // A nested package.json without a name (dist/commonjs/package.json's
    // {"type": "commonjs"}) is not the package's root.
    if (existsSync(pkg) && hasName(pkg)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function packageNameFromRoot(pkgRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    return pkg.name || relative(root, pkgRoot);
  } catch {
    return relative(root, pkgRoot);
  }
}

function findLicenseText(pkgRoot) {
  for (const name of LICENSE_NAMES) {
    const p = join(pkgRoot, name);
    if (existsSync(p) && statSync(p).isFile()) return readFileSync(p, 'utf8').trim();
  }
  // Some packages only declare license in package.json
  try {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    if (pkg.license && typeof pkg.license === 'string') {
      return `License: ${pkg.license}\n(See https://spdx.org/licenses/${pkg.license}.html)`;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Collect absolute input paths from one or more esbuild metafiles. */
export function packagesFromMetafiles(metafiles) {
  const pkgRoots = new Map();
  for (const meta of metafiles) {
    for (const input of Object.keys(meta.inputs || {})) {
      const abs = input.startsWith('/') ? input : join(root, input);
      if (!abs.includes('node_modules')) continue;
      const pkgRoot = findPackageRoot(abs);
      if (!pkgRoot || !pkgRoot.includes('node_modules')) continue;
      const name = packageNameFromRoot(pkgRoot);
      // Skip the package under test if somehow included
      if (name === '@ai-ecoverse/slicc-jsh') continue;
      if (!pkgRoots.has(name)) pkgRoots.set(name, pkgRoot);
    }
  }
  return pkgRoots;
}

export function renderNotice(pkgRoots) {
  const header = `@ai-ecoverse/slicc-jsh
Copyright 2026 AI Ecoverse contributors

This product includes software developed for SLICC (https://github.com/ai-ecoverse/slicc),
ported from the v6 JS realm (packages/webapp/src/kernel/realm/) under the Apache License,
Version 2.0.

Ported components originate from ai-ecoverse/slicc and remain under Apache-2.0.
See LICENSE for the full license text.

It also includes code from Node.js (https://github.com/nodejs/node): files of
its lib/ in src/node-lib/lib, and ports of others in src/runtime, under the
Node.js license reproduced in the node-inspect-extracted section below
("This project contains parts of Node.js").
`;

  const missing = [];
  const sections = [];
  const names = [...pkgRoots.keys()].sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const text = findLicenseText(pkgRoots.get(name));
    if (!text) {
      missing.push(name);
      continue;
    }
    sections.push(
      `--------------------------------------------------------------------------------\n` +
        `This product bundles ${name} (from npm). License text follows:\n\n` +
        `${text}\n`
    );
  }

  if (missing.length) {
    const err = new Error(
      `NOTICE generation failed: no LICENSE for bundled package(s): ${missing.join(', ')}`
    );
    err.missing = missing;
    throw err;
  }

  return `${header}\n${sections.join('\n')}`;
}

/** CLI: node scripts/generate-notice.mjs meta1.json meta2.json ... */
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('generate-notice.mjs')) {
  const metas = process.argv.slice(2).map((p) => JSON.parse(readFileSync(p, 'utf8')));
  if (!metas.length) {
    console.error('usage: generate-notice.mjs <metafile.json>...');
    process.exit(2);
  }
  const notice = renderNotice(packagesFromMetafiles(metas));
  writeFileSync(join(root, 'NOTICE'), notice);
  console.log(`NOTICE written (${packagesFromMetafiles(metas).size} packages)`);
}
