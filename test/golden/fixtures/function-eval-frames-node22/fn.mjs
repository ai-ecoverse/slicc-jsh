import { join } from "path";
const make = (body) => join("a") && new Function(body);
try {
  make("null.esm")();
} catch (e) {
  console.log(e.stack.split("\n").filter((l) => !l.includes("node:")).join("\n"));
}
make("null.top")();
