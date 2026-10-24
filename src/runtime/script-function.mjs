const toSource = Function.prototype.toString;

export function scriptFunction(ctx, { kind = 'function', params, body, filename }) {
  const runScript = ctx?.sync?.runScript;
  if (typeof runScript !== 'function') return undefined;
  const source = `(${kind} (${params.join(', ')}\n) {\n${body}\n})`;
  let fn;
  try {
    fn = runScript(source, { filename })?.value;
  } catch {
    return undefined;
  }
  if (typeof fn !== 'function' || Reflect.apply(toSource, fn, []) !== source.slice(1, -1)) return undefined;
  return fn;
}
