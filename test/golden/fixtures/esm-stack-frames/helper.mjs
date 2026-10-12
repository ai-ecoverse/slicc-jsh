export function inHelper() {
  return new Error('from helper').stack.split('\n')[1];
}
export function thisOf() { return this === undefined ? "undefined" : typeof this; }
