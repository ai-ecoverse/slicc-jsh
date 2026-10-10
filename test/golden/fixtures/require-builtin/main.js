const mods = ['fs', 'events', 'assert', 'util', 'os', 'url', 'querystring', 'string_decoder', 'stream', 'path', 'buffer'];
for (const id of mods) {
  const m = require(id);
  console.log(id, typeof m, typeof m.default === 'undefined' ? '-' : typeof m.default);
}
console.log(require.resolve('fs'));
