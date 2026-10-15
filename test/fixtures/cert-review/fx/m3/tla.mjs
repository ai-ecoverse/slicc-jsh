const v = await new Promise((r) => setTimeout(() => r('tla ok'), 20));
console.log(v, typeof require, import.meta.url.endsWith('/tla.mjs'), typeof import.meta.dirname, typeof import.meta.resolve);
