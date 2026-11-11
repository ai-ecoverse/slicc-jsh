const entries = [
  './for-of-var.mjs',
  './for-var.mjs',
  './for-in-var.mjs',
  './if-var.mjs',
  './try-var.mjs',
  './nested-fn-var.mjs',
  './default-param.mjs',
];
for (const spec of entries) {
  await import(spec);
}
