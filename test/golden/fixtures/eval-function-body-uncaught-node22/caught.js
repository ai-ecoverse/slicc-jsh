const run = globalThis["ev" + "al"];
try {
  run("null.c");
} catch (e) {
  console.log(e.stack.split("\n").filter((l) => l.includes("ev" + "al")).length > 0);
}
