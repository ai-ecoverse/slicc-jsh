export function f() {
  return new Error('q').stack.split('\n')[1];
}
