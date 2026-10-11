#!/usr/bin/env node
/**
 * Bundle each abi:js entry to a single file. slicc-kernel loads JS program
 * modules via data: URLs, which cannot resolve relative imports.
 *
 * Also builds lazy vendor CJS bundles (readable-stream, string_decoder) under
 * dist/vendor/ so require('stream') does not pay their cost for `node -e 0`.
 * NOTICE is regenerated from esbuild metafiles (every bundled package → LICENSE).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { packagesFromMetafiles, renderNotice } from './generate-notice.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const require = createRequire(join(root, 'package.json'));
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'vendor'), { recursive: true });

const main = await esbuild.build({
  entryPoints: {
    node: join(root, 'src/node.mjs'),
    jsh: join(root, 'src/jsh.mjs'),
  },
  outdir: dist,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: ['es2022'],
  logLevel: 'info',
  metafile: true,
});

const sdPath = require.resolve('string_decoder/');
// One Buffer class: vendor bundles must not ship npm `buffer` / safe-buffer.
const bufferShim = join(root, 'src/vendor-shims/buffer.cjs');
const vendorBufferAlias = {
  buffer: bufferShim,
  'safe-buffer': bufferShim,
};

const stream = await esbuild.build({
  entryPoints: [require.resolve('readable-stream/lib/ours/browser.js')],
  outfile: join(dist, 'vendor/readable-stream.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  target: ['es2022'],
  mainFields: ['main', 'module', 'browser'],
  logLevel: 'info',
  metafile: true,
  alias: {
    events: require.resolve('events/'),
    string_decoder: sdPath,
    'abort-controller': require.resolve('abort-controller'),
    ...vendorBufferAlias,
  },
  plugins: [
    {
      name: 'string-decoder-slash',
      setup(build) {
        build.onResolve({ filter: /^string_decoder\/$/ }, () => ({ path: sdPath }));
      },
    },
    {
      // Node 22 default highWaterMark is 65536; readable-stream still uses 16384.
      name: 'hwm-node22',
      setup(build) {
        build.onLoad({ filter: /streams[/\\]state\.js$/ }, async (args) => {
          const { readFile } = await import('node:fs/promises');
          let text = await readFile(args.path, 'utf8');
          text = text.replace(
            /defaultHighWaterMarkBytes\s*=\s*16\s*\*\s*1024/,
            'defaultHighWaterMarkBytes = 64 * 1024'
          );
          return { contents: text, loader: 'js' };
        });
      },
    },
  ],
});

const decoder = await esbuild.build({
  entryPoints: [sdPath],
  outfile: join(dist, 'vendor/string_decoder.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  target: ['es2022'],
  mainFields: ['main', 'module'],
  logLevel: 'info',
  metafile: true,
  alias: { ...vendorBufferAlias },
  plugins: [
    {
      // npm string_decoder 1.3 emits one U+FFFD for incomplete multibyte; Node
      // emits one per buffered byte (#22626). Keep resume index in lastNeed.
      name: 'utf8-replacement-22626',
      setup(build) {
        build.onLoad({ filter: /string_decoder[/\\]lib[/\\]string_decoder\.js$/ }, async (args) => {
          const { readFile } = await import('node:fs/promises');
          let text = await readFile(args.path, 'utf8');
          text = text.replace(
            /function utf8CheckExtraBytes\(self, buf, p\) \{[\s\S]*?\n\}/,
            `function utf8CheckExtraBytes(self, buf, p) {
  // Match V8/Node replacement counts for incomplete/invalid UTF-8 (#22626).
  function replacements(n) {
    const slice = self.lastChar.slice(0, n);
    return new TextDecoder('utf-8').decode(slice);
  }
  if ((buf[0] & 0xC0) !== 0x80) {
    self.lastNeed = 0;
    return replacements(p > 0 ? p : 1);
  }
  if (self.lastNeed > 1 && buf.length > 1) {
    if ((buf[1] & 0xC0) !== 0x80) {
      self.lastChar[p] = buf[0];
      self.lastNeed = 1;
      return replacements(p + 1);
    }
    if (self.lastNeed > 2 && buf.length > 2) {
      if ((buf[2] & 0xC0) !== 0x80) {
        self.lastChar[p] = buf[0];
        self.lastChar[p + 1] = buf[1];
        self.lastNeed = 2;
        return replacements(p + 2);
      }
    }
  }
}`
          );
          return { contents: text, loader: 'js' };
        });
      },
    },
  ],
});

writeFileSync(join(dist, 'meta-main.json'), JSON.stringify(main.metafile));
writeFileSync(join(dist, 'meta-stream.json'), JSON.stringify(stream.metafile));
writeFileSync(join(dist, 'meta-decoder.json'), JSON.stringify(decoder.metafile));

const pkgRoots = packagesFromMetafiles([main.metafile, stream.metafile, decoder.metafile]);
const notice = renderNotice(pkgRoots);
writeFileSync(join(root, 'NOTICE'), notice);
console.log(`NOTICE: ${pkgRoots.size} bundled package(s)`);

console.log('built dist/node.mjs, dist/jsh.mjs, and dist/vendor/*');
