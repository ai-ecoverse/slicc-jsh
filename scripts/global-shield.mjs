import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as acorn from 'acorn';
import { analyze } from 'eslint-scope';

export const GLOBAL = '__jshGlobal';
export const HELPER_GLOBALS = ['Object', 'Uint8Array'];
const CJS_PARAMS = ['exports', 'module', 'require', '__filename', '__dirname', ...HELPER_GLOBALS];
const UNSHADOWABLE = new Set(['undefined', 'NaN', 'Infinity', 'eval']);

function freeNames(code, kind) {
  const esm = kind === 'esm';
  const text = esm ? code : `(function (${[...CJS_PARAMS, GLOBAL].join(', ')}) {\n${code}\n})`;
  const ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: esm ? 'module' : 'script', allowHashBang: true, ranges: true });
  const scopes = analyze(ast, { ecmaVersion: 2024, sourceType: esm ? 'module' : 'script' });
  return new Set(scopes.globalScope.through.map((ref) => ref.identifier.name));
}

function outputsOf(result, options) {
  if (result.outputFiles) return result.outputFiles.map((f) => ({ path: f.path, text: f.text }));
  return Object.keys(result.metafile.outputs).map((p) => ({ path: p, text: readFileSync(join(options.absWorkingDir ?? process.cwd(), p), 'utf8') }));
}

export async function shieldedBuild(esbuild, options, { kind, injectFile }) {
  const probe = await esbuild.build({ ...options, write: false, logLevel: 'silent' });
  const names = new Set(['globalThis']);
  for (const out of outputsOf(probe, options)) {
    if (!/\.(mjs|cjs|js)$/.test(out.path)) continue;
    for (const name of freeNames(out.text, kind)) names.add(name);
  }
  const define = { ...(options.define ?? {}) };
  for (const name of names) {
    if (UNSHADOWABLE.has(name) || name === GLOBAL) continue;
    define[name] = name === 'globalThis' ? GLOBAL : `${GLOBAL}.${name}`;
  }
  const inject = kind === 'esm' ? [...(options.inject ?? []), injectFile] : options.inject;
  const result = await esbuild.build({ ...options, define, ...(inject ? { inject } : {}), metafile: true });
  for (const out of outputsOf(result, options)) {
    if (!/\.(mjs|cjs|js)$/.test(out.path)) continue;
    const left = [...freeNames(out.text, kind)].filter((name) => !UNSHADOWABLE.has(name) && name !== GLOBAL && !(kind === 'esm' && name === 'Object'));
    if (left.length) throw new Error(`global-shield: ${out.path} still looks up ${left.join(', ')} on the global scope`);
  }
  return result;
}
