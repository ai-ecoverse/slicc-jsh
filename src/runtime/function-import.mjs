/**
 * import() inside `new Function(...)` / `new AsyncFunction(...)` bodies.
 *
 * The runtime runs modules through its own loader, and the kernel refuses a
 * JS program's native dynamic import, so code compiled at run time with the
 * Function constructors (bundlers' `new Function('s', 'return import(s)')`
 * escape hatch, template engines) would fail. The constructors are wrapped:
 * a body with an `import(…)` call has those calls routed to the runtime's
 * loader, resolved — as V8 does for Function bodies — against the script
 * that created the function. Bodies without one compile exactly as before.
 */
import * as acorn from 'acorn';

const IMPORT_KEY = Symbol.for('slicc-jsh.functionImport');
const MAYBE_IMPORT = /\bimport\s*\(/;

function parseKind(Ctor, name) {
  // The constructors' own source shapes (ECMA-262 CreateDynamicFunction).
  if (name === 'AsyncFunction') return { prefix: 'async function anonymous(', ctor: Ctor };
  if (name === 'GeneratorFunction') return { prefix: 'function* anonymous(', ctor: Ctor };
  if (name === 'AsyncGeneratorFunction') return { prefix: 'async function* anonymous(', ctor: Ctor };
  return { prefix: 'function anonymous(', ctor: Ctor };
}

/** The body with each import(…) replaced, or null to leave it alone. */
function rewriteBody(prefix, params, body, referrer) {
  if (!MAYBE_IMPORT.test(body)) return null;
  const head = `(${prefix}${params}\n) {\n`;
  let ast;
  try {
    ast = acorn.parse(`${head}${body}\n})`, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch {
    return null; // the native constructor reports the SyntaxError
  }
  const edits = [];
  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'ImportExpression') {
      edits.push({ start: node.start - head.length, end: node.source.start - head.length });
    }
    for (const key of Object.keys(node)) {
      if (key === 'start' || key === 'end') continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  };
  walk(ast);
  if (edits.length === 0) return null;
  const call = `globalThis[Symbol.for('slicc-jsh.functionImport')](${JSON.stringify(referrer)}, `;
  let out = body;
  for (const { start, end } of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, start) + call + out.slice(end);
  }
  return out;
}

/** The file of the script calling the constructor (the import referrer). */
function callerFile(skip) {
  const holder = {};
  const prevPrepare = Error.prepareStackTrace;
  const prevLimit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 30;
    Error.prepareStackTrace = (_, sites) => sites;
    Error.captureStackTrace(holder, skip);
    const sites = Array.isArray(holder.stack) ? holder.stack : [];
    for (const site of sites) {
      const file = site.getFileName?.();
      if (file && (file.startsWith('/') || file.startsWith('file:'))) return file.replace(/^file:\/\//, '');
    }
  } catch {
    /* fall through */
  } finally {
    Error.prepareStackTrace = prevPrepare;
    Error.stackTraceLimit = prevLimit;
  }
  return undefined;
}

/**
 * @param {object} o
 * @param {(specifier: string, referrer: string) => Promise<object>} o.importFrom
 * @param {() => string} o.cwd referrer for code with no file (eval)
 * @returns {() => void} undo
 */
export function installFunctionImport({ importFrom, cwd }) {
  const undo = [];
  const set = (obj, key, value) => {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    try {
      Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: false });
      undo.push(() => {
        try {
          if (desc) Object.defineProperty(obj, key, desc);
          else delete obj[key];
        } catch {
          /* ignore */
        }
      });
      return true;
    } catch {
      return false; // frozen intrinsics: leave them
    }
  };

  set(globalThis, IMPORT_KEY, (referrer, specifier, options) => importFrom(String(specifier), referrer, options));

  const natives = [
    ['Function', Function],
    ['AsyncFunction', (async () => {}).constructor],
    ['GeneratorFunction', function* () {}.constructor],
    ['AsyncGeneratorFunction', async function* () {}.constructor],
  ];
  for (const [name, Native] of natives) {
    const { prefix } = parseKind(Native, name);
    // A plain function: callable and constructible, as the constructors are.
    const wrapped = function (...args) {
      const body = args.length ? String(args[args.length - 1]) : '';
      const params = args.slice(0, -1).map(String).join(',');
      const referrer = MAYBE_IMPORT.test(body) ? (callerFile(wrapped) ?? `${cwd()}/[eval]`) : undefined;
      const rewritten = referrer ? rewriteBody(prefix, params, body, referrer) : null;
      const target = new.target && new.target !== wrapped ? new.target : Native;
      if (rewritten === null) return Reflect.construct(Native, args, target);
      return Reflect.construct(Native, [...args.slice(0, -1), rewritten], target);
    };
    Object.defineProperty(wrapped, 'name', { value: name });
    Object.defineProperty(wrapped, 'prototype', { value: Native.prototype, writable: false });
    Object.defineProperty(wrapped, 'length', { value: Native.length });
    Object.setPrototypeOf(wrapped, Object.getPrototypeOf(Native));
    if (name === 'Function') set(globalThis, 'Function', wrapped);
    set(Native.prototype, 'constructor', wrapped);
  }
  return () => {
    for (const u of undo.reverse()) u();
  };
}
