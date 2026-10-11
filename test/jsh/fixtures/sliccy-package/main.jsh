console.log(require('sliccy:demo').who, require('sliccy:other').who);
try {
  require('sliccy:browser');
} catch (err) {
  console.log(err.message);
}
