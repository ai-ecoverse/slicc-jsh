function load() {
  throw new Error("load failed", { cause: new Error("inner {\n  z") });
}
load();
