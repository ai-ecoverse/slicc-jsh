function make(body) {
  return new Function(body);
}
try { make("null.z")(); } catch (e) { console.log(e.stack); }
