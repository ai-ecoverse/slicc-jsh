// src/orig.ts
function describe(p) {
  if (p.x < 0) {
    throw new Error(`negative x: ${p.x}`);
  }
  return `(${p.x}, ${p.y})`;
}
function run(points) {
  return points.map((p) => describe(p));
}

// src/main.ts
console.log(run([{ x: 1, y: 2 }]));
try {
  run([{ x: -1, y: 0 }]);
} catch (e) {
  console.log(e.stack);
}
run([{ x: -2, y: 0 }]);
//# sourceMappingURL=nosrc.js.map
