for (const id of ['sliccy:usb', 'sliccy:agent', 'sliccy:nope', 'sliccy:']) {
  try {
    require(id);
  } catch (err) {
    console.log(err.message);
  }
}
console.log(require.resolve('sliccy:cli'));
