const k = () => eval("null.m");
try {
  k();
} catch (e) {
  console.log(e.stack);
}
await 0;
