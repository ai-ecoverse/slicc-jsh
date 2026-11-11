const entries = [
  './for-of.mjs',
  './for.mjs',
  './for-in.mjs',
  './rest-fn.mjs',
  './rest-arrow.mjs',
  './rest-array.mjs',
  './closure-loop.mjs',
  './nested-shadow.mjs',
  './named-import.mjs',
];
for (const spec of entries) {
  await import(spec);
}
