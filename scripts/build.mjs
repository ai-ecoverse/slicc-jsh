#!/usr/bin/env node
/**
 * Bundle each abi:js entry to a single file. slicc-kernel loads JS program
 * modules via data: URLs, which cannot resolve relative imports.
 *
 * Also builds lazy vendor CJS bundles (readable-stream, string_decoder) under
 * dist/vendor/, and embeds their sources in vendor-embedded.mjs so getStream()
 * does not sync-read a fixed /node_modules/@ai-ecoverse/slicc-jsh path (pnpm
 * global installs live under $PNPM_HOME/global/v11/<hash>/).
 * NOTICE is regenerated from esbuild metafiles (every bundled package → LICENSE).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// crypto: @noble/hashes (digests, HMAC, PBKDF2, HKDF, scrypt) and
// browserify-aes / browserify-des (block ciphers); Node's API over them is
// src/runtime/builtins/crypto.mjs. cipher-base's stream and string_decoder are
// the runtime's.
const crypto = await esbuild.build({
  entryPoints: [join(root, 'src/vendor-shims/crypto-entry.cjs')],
  outfile: join(dist, 'vendor/crypto.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  mainFields: ['browser', 'main', 'module'],
  logLevel: 'info',
  metafile: true,
  external: ['stream', 'readable-stream', 'util', 'events', 'string_decoder'],
  alias: {
    ...vendorBufferAlias,
    evp_bytestokey: join(root, 'src/vendor-shims/evp-bytestokey.cjs'),
    'to-buffer': join(root, 'src/vendor-shims/to-buffer.cjs'),
  },
  minify: true,
  keepNames: true,
  legalComments: 'inline',
  plugins: [
    {
      // GCM: a decipher's tag may be 4–16 bytes (Node's authTagLength); compare
      // the computed tag's prefix rather than requiring all 16.
      name: 'crypto-gcm',
      setup(b) {
        b.onLoad({ filter: /browserify-aes[\\/]authCipher\.js$/ }, (args) => {
          let src = readFileSync(args.path, 'utf8');
          const patch = (from, to) => {
            if (!src.includes(from)) throw new Error(`crypto-gcm: authCipher.js changed (${from})`);
            src = src.replace(from, to);
          };
          patch(
            'if (this._decrypt && xorTest(tag, this._authTag))',
            'if (this._decrypt && xorTest(tag.slice(0, this._authTag.length), this._authTag))'
          );
          // A non-96-bit IV's length block: Buffer#writeUIntBE takes at most 6
          // bytes, so write the bit count into the low 6 of the zeroed 8.
          patch('tail.writeUIntBE(ivBits, 0, 8)', 'tail.writeUIntBE(ivBits, 2, 6)');
          return { contents: src, loader: 'js' };
        });
      },
    },
  ],
});

// zlib: browserify-zlib (Node's zlib.js over pako 1.x). stream, util and
// assert stay external: the runtime hands its own to the bundle's require().
const zlib = await esbuild.build({
  entryPoints: [require.resolve('browserify-zlib/lib/index.js')],
  outfile: join(dist, 'vendor/zlib.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  target: ['es2022'],
  mainFields: ['main', 'module'],
  logLevel: 'info',
  metafile: true,
  external: ['stream', 'util', 'assert', '__jsh/zlib-options'],
  alias: { ...vendorBufferAlias },
  plugins: [
    {
      // Node 22 behaviour the port (Node 8's zlib.js) lacks: option validation
      // with Node's errors (src/runtime/builtins/zlib.mjs), ArrayBuffer and
      // TypedArray input, `{ info: true }`, and destroy() closing the handle.
      name: 'zlib-node22',
      setup(build) {
        build.onLoad({ filter: /browserify-zlib[/\\]lib[/\\]index\.js$/ }, async (args) => {
          const { readFile } = await import('node:fs/promises');
          let text = await readFile(args.path, 'utf8');
          const patch = (from, to) => {
            if (!text.includes(from)) throw new Error(`zlib-node22: no match for ${from}`);
            text = text.replace(from, to);
          };
          patch(
            'this._opts = opts = opts || {};',
            "this._opts = opts = require('__jsh/zlib-options').options(opts || {}, mode);"
          );
          patch(
            '  engine.end(buffer);\n  flow();',
            "  buffer = require('__jsh/zlib-options').input(buffer);\n  engine.end(buffer);\n  flow();"
          );
          patch(
            '    callback(err, buf);',
            '    callback(err, buf && engine._opts.info ? { buffer: buf, engine: engine } : buf);'
          );
          patch(
            "  if (typeof buffer === 'string') buffer = Buffer.from(buffer);\n\n  if (!Buffer.isBuffer(buffer)) throw new TypeError('Not a string or buffer');",
            "  buffer = require('__jsh/zlib-options').input(buffer);"
          );
          patch(
            '  return engine._processChunk(buffer, flushFlag);',
            '  var out = engine._processChunk(buffer, flushFlag);\n  return engine._opts.info ? { buffer: out, engine: engine } : out;'
          );
          patch(
            'util.inherits(Zlib, Transform);',
            'util.inherits(Zlib, Transform);\n\nZlib.prototype._destroy = function (err, callback) {\n  _close(this);\n  callback(err);\n};'
          );
          // Node 22's close is destroy (one 'close' event; the callback via
          // finished), not Node 8's close-and-emit.
          patch(
            'Zlib.prototype.close = function (callback) {\n  _close(this, callback);\n  process.nextTick(emitCloseNT, this);\n};',
            "Zlib.prototype.close = function (callback) {\n  if (callback) require('stream').finished(this, callback);\n  this.destroy();\n};"
          );
          // maxOutputLength (Node 22): ERR_BUFFER_TOO_LARGE past the limit.
          patch(
            '    if (nread >= kMaxLength) {\n      err = new RangeError(kRangeErrorMessage);',
            "    if (nread > engine._opts.maxOutputLength) {\n      err = require('__jsh/zlib-options').tooLarge(engine._opts.maxOutputLength);"
          );
          patch(
            '    if (nread >= kMaxLength) {\n      _close(this);\n      throw new RangeError(kRangeErrorMessage);',
            "    if (nread > this._opts.maxOutputLength) {\n      _close(this);\n      throw require('__jsh/zlib-options').tooLarge(this._opts.maxOutputLength);"
          );
          // params() validates as Node 22 does.
          patch(
            'Zlib.prototype.params = function (level, strategy, callback) {',
            "Zlib.prototype.params = function (level, strategy, callback) {\n  require('__jsh/zlib-options').params(level, strategy);"
          );
          // A destroyed stream reports nothing more (a write still in flight).
          patch(
            '  this._handle.onerror = function (message, errno) {',
            '  this._handle.onerror = function (message, errno) {\n    if (self.destroyed) return;'
          );
          // bytesWritten: the input bytes the engine has consumed, as Node counts
          // them (processCallback stops for a destroyed stream first).
          patch('  Transform.call(this, opts);\n', '  Transform.call(this, opts);\n  this.bytesWritten = 0;\n');
          patch(
            '    if (self._hadError) return;\n\n    var have = availOutBefore - availOutAfter;',
            '    if (self._hadError || self.destroyed) return;\n\n    self.bytesWritten += availInBefore - availInAfter;\n    var have = availOutBefore - availOutAfter;'
          );
          return { contents: text, loader: 'js' };
        });
        // Raw inflate gets its dictionary at init (zlib has no Z_NEED_DICT
        // for raw streams), as Node's binding does.
        build.onLoad({ filter: /browserify-zlib[/\\]lib[/\\]binding\.js$/ }, async (args) => {
          const { readFile } = await import('node:fs/promises');
          let text = await readFile(args.path, 'utf8');
          const from = '      this.err = zlib_deflate.deflateSetDictionary(this.strm, this.dictionary);\n      break;';
          if (!text.includes(from)) throw new Error('zlib-node22: binding.js dictionary hook moved');
          text = text.replace(
            from,
            `${from}\n    case exports.INFLATERAW:\n      this.err = zlib_inflate.inflateSetDictionary(this.strm, this.dictionary);\n      break;`
          );
          return { contents: text, loader: 'js' };
        });
      },
    },
  ],
  // Embedded in dist/*.mjs as a string: keep it small. Names stay for stacks.
  minify: true,
  keepNames: true,
  legalComments: 'inline',
});

const vendorEmbeddedPath = join(root, 'src/runtime/vendor-embedded.mjs');
const vendorEmbeddedPlaceholder = `/**
 * @generated by scripts/build.mjs — placeholder until the next build.
 * The real map (readable-stream / string_decoder sources) is written at build
 * time and bundled into dist/node.mjs and dist/jsh.mjs so vendor load does not
 * depend on a fixed /node_modules/@ai-ecoverse/slicc-jsh path (pnpm global
 * installs live under $PNPM_HOME/global/v11/<hash>/).
 */
export const VENDOR = {};
`;

/** Embed vendor CJS text so runtime load does not depend on install path. */
function writeVendorEmbedded(full) {
  if (!full) {
    writeFileSync(vendorEmbeddedPath, vendorEmbeddedPlaceholder);
    return;
  }
  const names = ['readable-stream', 'string_decoder', 'zlib', 'crypto'];
  const entries = names.map((name) => {
    const text = readFileSync(join(dist, 'vendor', `${name}.cjs`), 'utf8');
    return `  ${JSON.stringify(name)}: ${JSON.stringify(text)}`;
  });
  const body = `/**
 * @generated by scripts/build.mjs — do not edit.
 * Embedded vendor CJS sources for lazy eval (see vendor-load.mjs).
 */
export const VENDOR = {
${entries.join(',\n')},
};
`;
  writeFileSync(vendorEmbeddedPath, body);
}

writeVendorEmbedded(true);

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

// Keep the source tree small; dist bundles already inlined the map.
writeVendorEmbedded(false);

writeFileSync(join(dist, 'meta-main.json'), JSON.stringify(main.metafile));
writeFileSync(join(dist, 'meta-stream.json'), JSON.stringify(stream.metafile));
writeFileSync(join(dist, 'meta-decoder.json'), JSON.stringify(decoder.metafile));
writeFileSync(join(dist, 'meta-zlib.json'), JSON.stringify(zlib.metafile));
writeFileSync(join(dist, 'meta-crypto.json'), JSON.stringify(crypto.metafile));

const pkgRoots = packagesFromMetafiles([main.metafile, stream.metafile, decoder.metafile, zlib.metafile, crypto.metafile]);
const notice = renderNotice(pkgRoots);
writeFileSync(join(root, 'NOTICE'), notice);
console.log(`NOTICE: ${pkgRoots.size} bundled package(s)`);

console.log('built dist/node.mjs, dist/jsh.mjs, dist/vendor/*, and vendor-embedded.mjs');
