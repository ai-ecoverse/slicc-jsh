// require('.') and require('..') are paths (mongodb's lib/mongo_client.js and
// @redis/client require '.'), and with a trailing '/' (or '/.', '/..') a
// request names a directory only, never the file beside it.
const path = require('path');
const rel = (p) => path.relative(path.dirname(__dirname), p);
const t = (r) => {
  try {
    console.log(JSON.stringify(r), require(r), rel(require.resolve(r)));
  } catch (e) {
    console.log(JSON.stringify(r), e.code, e.message.split('\n')[0]);
  }
};
for (const r of ['.', '..', './', '../', './sub', './sub/', './sub/.', './sub/..', '../lib', '../lib/', '...', './nothing/']) t(r);
console.log(require('./sub/use-dot'));
