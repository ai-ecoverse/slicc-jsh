interface Point {
  x: number;
  y: number;
}

function describe(p: Point): string {
  if (p.x < 0) {
    throw new Error(`negative x: ${p.x}`);
  }
  return `(${p.x}, ${p.y})`;
}

export function run(points: Point[]): string[] {
  return points.map((p) => describe(p));
}
