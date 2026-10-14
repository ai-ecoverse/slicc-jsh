// import() from CommonJS: the importer's awaiting frame too.
const clean = (s) => s.split(__dirname).join('DIR').split('\n').filter((l) => !l.includes('node:')).join('\n');
module.exports = async function fromCjs() {
  try {
    await import('./bad.mjs?cjs');
  } catch (e) {
    console.log(clean(e.stack));
  }
};
