import { join } from "path";
function f() {
  return join("a") + eval("null.esmq");
}
f();
