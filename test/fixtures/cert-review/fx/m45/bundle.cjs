"use strict";

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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic3JjL29yaWcuanMiLCAic3JjL2VudHJ5LmpzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJmdW5jdGlvbiBoZWxwZXIoeCkge1xuICBpZiAoeCA+IDIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ2Zyb20gb3JpZ2luYWwgc291cmNlJyk7XG4gIH1cbiAgcmV0dXJuIGhlbHBlcih4ICsgMSk7XG59XG5leHBvcnQgZnVuY3Rpb24gcnVuKCkgeyByZXR1cm4gaGVscGVyKDApOyB9XG4iLCAiaW1wb3J0IHsgcnVuIH0gZnJvbSAnLi9vcmlnLmpzJztcbnRyeSB7IHJ1bigpOyB9IGNhdGNoIChlKSB7IGNvbnNvbGUubG9nKGUuc3RhY2suc3BsaXQoJ1xcbicpLnNsaWNlKDAsIDMpLm1hcCgobCkgPT4gbC5yZXBsYWNlKC9cXCguKltcXFxcL10vLCAnKCcpLnRyaW0oKSkuam9pbignIHwgJykpOyB9XG5ydW4oKTtcbiJdLAogICJtYXBwaW5ncyI6ICI7OztBQUFBLFNBQVMsT0FBTyxHQUFHO0FBQ2pCLE1BQUksSUFBSSxHQUFHO0FBQ1QsVUFBTSxJQUFJLE1BQU0sc0JBQXNCO0FBQUEsRUFDeEM7QUFDQSxTQUFPLE9BQU8sSUFBSSxDQUFDO0FBQ3JCO0FBQ08sU0FBUyxNQUFNO0FBQUUsU0FBTyxPQUFPLENBQUM7QUFBRzs7O0FDTDFDLElBQUk7QUFBRSxNQUFJO0FBQUcsU0FBUyxHQUFHO0FBQUUsVUFBUSxJQUFJLEVBQUUsTUFBTSxNQUFNLElBQUksRUFBRSxNQUFNLEdBQUcsQ0FBQyxFQUFFLElBQUksQ0FBQyxNQUFNLEVBQUUsUUFBUSxhQUFhLEdBQUcsRUFBRSxLQUFLLENBQUMsRUFBRSxLQUFLLEtBQUssQ0FBQztBQUFHO0FBQ3BJLElBQUk7IiwKICAibmFtZXMiOiBbXQp9Cg==
