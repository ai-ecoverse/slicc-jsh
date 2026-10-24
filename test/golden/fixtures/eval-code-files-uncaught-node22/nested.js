function f() {
  eval("let x = 1;\neval(\"null.inner\")");
}
f();
