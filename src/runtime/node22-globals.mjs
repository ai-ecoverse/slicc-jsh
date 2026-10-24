const NEWER = [
  [globalThis, 'Float16Array'],
  [Math, 'f16round'],
  [DataView.prototype, 'getFloat16'],
  [DataView.prototype, 'setFloat16'],
];

export function hideNewerBuiltins(builtins = NEWER) {
  const hidden = [];
  for (const [target, name] of builtins) {
    const desc = Object.getOwnPropertyDescriptor(target, name);
    if (!desc?.configurable) continue;
    delete target[name];
    hidden.push([target, name, desc]);
  }
  return () => {
    for (const [target, name, desc] of hidden) Object.defineProperty(target, name, desc);
  };
}
