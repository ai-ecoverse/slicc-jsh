const v = await new Promise((r) => setTimeout(() => r('awaited'), 10));
console.log(v);
for await (const x of [Promise.resolve(1), 2]) console.log('for await', x);
