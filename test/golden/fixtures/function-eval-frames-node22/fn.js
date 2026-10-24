function make(body) {
  return new Function("x", body);
}
try {
  make("return x.y")(null);
} catch (e) {
  console.log(e.stack.split("\n").filter((l) => !l.includes("node:")).join("\n"));
}
make("\n  return null.file;")();
