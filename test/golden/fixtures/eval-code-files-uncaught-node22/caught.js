function k() {
  return eval("(() => null.c)()");
}
try {
  k();
} catch (e) {
  console.log(e.stack);
}
