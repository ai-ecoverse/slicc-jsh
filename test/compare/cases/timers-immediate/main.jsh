const log = [];
const i = setImmediate(() => log.push('cleared (never)'));
clearImmediate(i);
setTimeout(() => log.push('timeout10'), 10);
setImmediate(() => log.push('immediate'));
await new Promise((r) => setTimeout(r, 40));
console.log(log.join(' '));
