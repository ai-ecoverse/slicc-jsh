// test/integration/cert-jsh-0.2.0/fx/m45/src/orig.js
function helper(x) {
  if (x > 2) {
    throw new Error("from original source");
  }
  return helper(x + 1);
}
function run() {
  return helper(0);
}

// test/integration/cert-jsh-0.2.0/fx/m45/src/entry.js
try {
  run();
} catch (e) {
  console.log(e.stack.split("\n").slice(0, 3).map((l) => l.replace(/\(.*[\\/]/, "(").trim()).join(" | "));
}
run();
//# sourceMappingURL=bundle.mjs.map
