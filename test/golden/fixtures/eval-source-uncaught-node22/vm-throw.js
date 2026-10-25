const vm = require("vm");
const code = "\nif (process.argv[2]) throw new Error(\"never\"); null.v";
for (const [source, filename] of [[code, "b.vm"], ["\n\t\tnull.w", "t.vm"]]) {
  try {
    vm.runInThisContext(source, { filename });
  } catch (e) {
    console.log(e.stack.split("\n").slice(0, 4).join("\n"));
  }
}
vm.runInThisContext(code, { filename: "c.vm" });
