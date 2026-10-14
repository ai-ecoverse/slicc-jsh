// A throw in a module loaded by await import(): V8's async frames name the
// importer's awaiting functions, as in Node (at async load (…), at async
// file:///importer.mjs:…). Node's own frames are left out: jsh has none.
import { createRequire } from 'node:module';
const dir = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const clean = (s) => s.split(dir).join('DIR').split('\n').filter((l) => !l.includes('node:')).join('\n');
async function load(spec) {
  try {
    await import(spec);
  } catch (e) {
    console.log(clean(e.stack));
  }
}
async function outer() {
  await load('./bad.mjs');
}
await outer();
// (A throw after the module's own top-level await: Node names no importer
// frame there, an artifact of its module job; jsh does. Not compared.)
await load('./bad-tla-before.mjs');
try {
  await import('./bad.mjs?top');
} catch (e) {
  console.log(clean(e.stack));
}
async function callExport() {
  const { f } = await import('./fn.mjs');
  f();
}
await callExport().catch((e) => console.log(clean(e.stack)));
await createRequire(import.meta.url)('./cjs.js')();
import('./bad.mjs?then').catch((e) => console.log(clean(e.stack)));
