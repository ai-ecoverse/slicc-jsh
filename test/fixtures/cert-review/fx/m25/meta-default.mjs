export default import.meta.url.endsWith('meta-default.mjs');
console.log((await import('./meta-default.mjs')).default);
