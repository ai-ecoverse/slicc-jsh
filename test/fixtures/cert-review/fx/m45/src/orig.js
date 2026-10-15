function helper(x) {
  if (x > 2) {
    throw new Error('from original source');
  }
  return helper(x + 1);
}
export function run() { return helper(0); }
