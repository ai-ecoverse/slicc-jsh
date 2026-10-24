eval("function g() {\n  return null.g;\n}");
function h() {
  g();
}
h();
