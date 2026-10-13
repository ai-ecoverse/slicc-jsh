/**
 * vm: scripts compiled and run in the program's own realm, which is all a
 * JS process here has (V8's contextify, a context per object, needs its
 * C++ bindings).
 *
 * - `runInThisContext` runs a classic script as V8 does: its top-level
 *   declarations stay in the global scope for the next script (an indirect
 *   eval keeps only `var` and function declarations, so top-level `let`,
 *   `const` and `class` are declared with `var`: they stay, but `const`
 *   isn't read-only and a name can be declared again);
 * - a context (`createContext`, `runInContext`, `runInNewContext`) is the
 *   object in front of the program's globals: names the script declares or
 *   assigns go on it, other names read through to the ECMAScript globals.
 *   It is not a separate realm (its `Object` is the program's);
 * - a SyntaxError is V8's (its message, and for the REPL the arrow under
 *   the token, which `decorateErrorStack` adds to the stack);
 * - an `import()` in a script goes to its `importModuleDynamically` (Node's:
 *   a function, or `vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER` for the
 *   program's loader); without one it rejects with
 *   ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING.
 *
 * Not here: `breakOnSigint` / `timeout` (a running script can't be
 * interrupted), cached data (accepted, never used), `vm.Module`,
 * `measureMemory`.
 */
import * as acorn from 'acorn';
import {
  ERR_INVALID_ARG_TYPE,
  kValidateObjectAllowArray,
  kValidateObjectAllowFunction,
  nodeError,
  validateFunction,
  validateObject,
  validateString,
} from '../node-errors.mjs';

const kAllowObjects = kValidateObjectAllowArray | kValidateObjectAllowFunction;
/** lib/internal/vm's own scripts (the REPL's): their importModuleDynamically needs no flag. */
export const kInternalScript = Symbol('slicc-jsh.vmInternalScript');
import { registerVmFile } from '../stack.mjs';

/**
 * Names a script in this context sees though the realm can't hold them on
 * globalThis (the Node-hosted kernel locks `module` and `require` there):
 * the REPL's. Scripts run inside a `with` over them while there are any.
 */
const OVERLAY = Symbol.for('slicc-jsh.vmGlobalOverlay');
export function setGlobalOverlay(names) {
  Object.defineProperty(globalThis, OVERLAY, { value: names, configurable: true, writable: true });
}

/** V8's own fresh-context globals (Node 22.22.0's vm.runInNewContext('Object.getOwnPropertyNames(globalThis)')). */
const ES_GLOBALS = [
  'Object', 'Function', 'Array', 'Number', 'parseFloat', 'parseInt', 'Infinity', 'NaN', 'undefined', 'Boolean',
  'String', 'Symbol', 'Date', 'Promise', 'RegExp', 'Error', 'AggregateError', 'EvalError', 'RangeError',
  'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'globalThis', 'JSON', 'Math', 'Intl', 'ArrayBuffer',
  'Atomics', 'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array',
  'Float64Array', 'Uint8ClampedArray', 'BigUint64Array', 'BigInt64Array', 'DataView', 'Map', 'BigInt', 'Set',
  'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'FinalizationRegistry', 'WeakRef', 'decodeURI', 'decodeURIComponent',
  'encodeURI', 'encodeURIComponent', 'escape', 'unescape', 'eval', 'isFinite', 'isNaN', 'console', 'Iterator',
  'SharedArrayBuffer', 'WebAssembly',
];

/** The arrow V8 keeps on a SyntaxError (`file:line\nsource line\n   ^^^\n`); decorateErrorStack prints it. */
export const kArrowMessage = Symbol('node:arrowMessage');
export const kDecorated = Symbol('node:decorated');

const PARSE = { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, locations: true };

/** The token at `pos` (its end), for the arrow's carets. */
function tokenEnd(code, pos) {
  try {
    const t = acorn.tokenizer(code.slice(pos), { ecmaVersion: 'latest' }).getToken();
    if (t.end > t.start) return pos + t.end;
  } catch {
    /* an unterminated token: one caret */
  }
  return pos + 1;
}

/** V8's SyntaxError for `code` (the message its compiler gives), with the arrow where acorn stopped. */
function syntaxError(code, acornErr, filename, lineOffset) {
  let err;
  try {
    // A function body is parsed like a script, but for `return` and the like.
    // eslint-disable-next-line no-new-func
    new Function(code);
  } catch (e) {
    if (e instanceof SyntaxError) err = e;
  }
  const pos = acornErr.pos ?? 0;
  // At the end of the script, V8's message is its own (the Function body's
  // closing brace is what new Function sees there).
  const atEnd = code.slice(pos).trim() === '';
  if (atEnd && (!err || /'\}'/.test(err.message))) err = new SyntaxError('Unexpected end of input');
  if (!err) {
    const msg = String(acornErr.message).replace(/ \(\d+:\d+\)$/, '');
    err = new SyntaxError(/'return' outside of function/.test(msg) ? 'Illegal return statement' : msg);
  }
  const loc = acornErr.loc ?? { line: 1, column: 0 };
  const lineStart = code.lastIndexOf('\n', pos - 1) + 1;
  let lineEnd = code.indexOf('\n', pos);
  if (lineEnd === -1) lineEnd = code.length;
  const text = code.slice(lineStart, lineEnd);
  const end = Math.min(tokenEnd(code, pos), lineEnd);
  const carets = pos >= lineEnd ? '' : '^'.repeat(Math.max(1, end - pos));
  // V8 keeps the arrow as a private symbol: never seen by inspect.
  Object.defineProperty(err, kArrowMessage, {
    value: `${filename}:${loc.line + lineOffset}\n${text}\n${' '.repeat(pos - lineStart)}${carets}\n`,
    configurable: true,
    writable: true,
  });
  // The stack is V8's for the script, not for this compile; and, as
  // Node's compile does, the arrow goes before it (decorated once).
  err.stack = `SyntaxError: ${err.message}`;
  decorateErrorStack(err);
  return err;
}

/**
 * Compile: the parse (V8's errors), then the source as run — top-level
 * lexical declarations as `var` (for the global scope, see above) and
 * import() through the runtime's loader.
 */
const VM_IMPORT = Symbol.for('slicc-jsh.vmImport');
const scripts = new Map();
let nextScriptId = 1;

function compile(code, filename, lineOffset, scriptId) {
  let ast;
  try {
    ast = acorn.parse(code, PARSE);
  } catch (e) {
    throw syntaxError(code, e, filename, lineOffset);
  }
  const edits = [];
  for (const node of ast.body) {
    if (node.type === 'VariableDeclaration' && (node.kind === 'let' || node.kind === 'const')) {
      edits.push({ start: node.start, end: node.start + node.kind.length, text: 'var' });
    } else if (node.type === 'ClassDeclaration' && node.id) {
      edits.push({ start: node.start, end: node.start, text: `var ${node.id.name} = ` });
      edits.push({ start: node.end, end: node.end, text: ';' });
    }
  }
  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'ImportExpression') {
      edits.push({ start: node.start, end: node.source.start, text: `globalThis[Symbol.for('slicc-jsh.vmImport')](${scriptId}, ` });
    }
    for (const key of Object.keys(node)) {
      if (key === 'start' || key === 'end' || key === 'loc') continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  };
  if (/\bimport\s*\(/.test(code)) walk(ast);
  let out = code;
  for (const { start, end, text } of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    out = out.slice(0, start) + text + out.slice(end);
  }
  // Line numbers in the stack: the script's own (offset), named as its file.
  return { body: out, lines: '\n'.repeat(Math.max(0, lineOffset)), sourceURL: `\n//# sourceURL=${filename}` };
}

/** The source as run in this context: in the `with` over the overlay when there is one (first-line columns shifted by it). */
function thisContextSource(compiled, filename) {
  const overlay = globalThis[OVERLAY];
  if (!overlay) {
    registerVmFile(filename, 0);
    return `${compiled.lines}${compiled.body}${compiled.sourceURL}`;
  }
  const head = `with (globalThis[Symbol.for('slicc-jsh.vmGlobalOverlay')]) {`;
  registerVmFile(filename, compiled.lines ? 0 : head.length);
  return `${compiled.lines ? `${compiled.lines.slice(1)}${head}\n` : head}${compiled.body}\n}${compiled.sourceURL}`;
}

const contexts = new WeakMap();

export function createVm({
  cwd = () => '/',
  importFrom = () => Promise.reject(new Error('no loader')),
  execArgv = () => [],
  emitWarning = () => {},
} = {}) {
  const experimentalVmModules = () => execArgv().includes('--experimental-vm-modules');
  let warnedMainContextLoader = false;
  const indirectEval = eval;

  const referrerOf = (filename) =>
    typeof filename === 'string' && filename.startsWith('/') ? filename : `${cwd().replace(/\/$/, '')}/${filename}`;

  // import() in a script: its importModuleDynamically, as Node calls it.
  if (!globalThis[VM_IMPORT]) {
    Object.defineProperty(globalThis, VM_IMPORT, {
      configurable: true,
      value: (id, specifier, options) => {
        const entry = scripts.get(id)?.deref();
        const callback = entry?.importModuleDynamically;
        const attributes = options?.with ?? options?.assert ?? {};
        return Promise.resolve().then(() => {
          if (callback === vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER) {
            return importFrom(String(specifier), referrerOf(entry.filename), options);
          }
          if (typeof callback !== 'function') {
            throw nodeError(TypeError, 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING', 'A dynamic import callback was not specified.');
          }
          // A user's callback is vm.Module territory (Node: behind --experimental-vm-modules).
          if (!entry.internal && !experimentalVmModules()) {
            throw nodeError(
              TypeError,
              'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG',
              'A dynamic import callback was invoked without --experimental-vm-modules'
            );
          }
          return callback(String(specifier), entry.script, attributes);
        });
      },
    });
  }

  /** The scope a context's scripts run in: its object, then the ECMAScript globals. */
  function scopeOf(sandbox) {
    let scope = contexts.get(sandbox);
    if (scope) return scope;
    const esGlobals = new Set(ES_GLOBALS);
    scope = new Proxy(sandbox, {
      has: (target, key) => key !== Symbol.unscopables && key !== '__jsh_vm_code__',
      get: (target, key) => {
        if (key === Symbol.unscopables) return undefined;
        if (key in target) return target[key];
        if (key === 'globalThis') return sandbox;
        if (typeof key === 'string' && esGlobals.has(key)) return globalThis[key];
        return undefined;
      },
      set: (target, key, value) => {
        target[key] = value;
        return true;
      },
    });
    contexts.set(sandbox, scope);
    return scope;
  }

  function runInScope(source, sandbox) {
    const scope = scopeOf(sandbox);
    // Sloppy direct eval inside `with`: what the script declares (var /
    // function) lands in the function's scope, so declarations are turned
    // into assignments first (they then go on the context).
    // eslint-disable-next-line no-new-func
    const run = new Function('__jsh_vm_scope__', '__jsh_vm_code__', 'with (__jsh_vm_scope__) { return eval(__jsh_vm_code__); }');
    return run(scope, source);
  }

  /** Top-level var / function declarations as assignments to the context. */
  function contextSource(code) {
    let ast;
    try {
      ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
    } catch {
      return code;
    }
    const edits = [];
    for (const node of ast.body) {
      if (node.type === 'VariableDeclaration' && node.kind === 'var') {
        if (node.declarations.every((d) => d.id.type === 'Identifier')) {
          const parts = node.declarations.map((d) => (d.init ? `${d.id.name} = ${code.slice(d.init.start, d.init.end)}` : `${d.id.name} = ${d.id.name}`));
          edits.push({ start: node.start, end: node.end, text: `void (${parts.join(', ')});` });
        }
      } else if (node.type === 'FunctionDeclaration' && node.id) {
        edits.push({ start: node.start, end: node.start, text: `${node.id.name} = ` });
        edits.push({ start: node.end, end: node.end, text: ';' });
      }
    }
    let out = code;
    for (const { start, end, text } of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
      out = out.slice(0, start) + text + out.slice(end);
    }
    return out;
  }

  const optionsOf = (options, defaultName) => {
    if (typeof options === 'string') return { filename: options };
    if (options === undefined || options === null) return { filename: defaultName };
    validateObject(options, 'options');
    return options;
  };

  class Script {
    constructor(code, options = {}) {
      code = `${code}`;
      const opts = optionsOf(options, 'evalmachine.<anonymous>');
      const filename = opts.filename ?? 'evalmachine.<anonymous>';
      validateString(filename, 'options.filename');
      const lineOffset = opts.lineOffset ?? 0;
      this._filename = filename;
      this._code = code;
      this._lineOffset = lineOffset;
      const id = nextScriptId++;
      if (opts.importModuleDynamically === vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER && !warnedMainContextLoader) {
        warnedMainContextLoader = true;
        emitWarning('vm.USE_MAIN_CONTEXT_DEFAULT_LOADER is an experimental feature and might change at any time', 'ExperimentalWarning');
      }
      scripts.set(
        id,
        new WeakRef({ script: this, filename, importModuleDynamically: opts.importModuleDynamically, internal: !!opts[kInternalScript] })
      );
      this._importEntry = scripts.get(id).deref();
      this._compiled = compile(code, filename, lineOffset, id);
      this.cachedDataRejected = opts.cachedData ? false : undefined;
      if (opts.importModuleDynamically !== undefined && typeof opts.importModuleDynamically !== 'function' && typeof opts.importModuleDynamically !== 'symbol') {
        validateFunction(opts.importModuleDynamically, 'options.importModuleDynamically');
      }
    }
    runInThisContext(options) {
      try {
        return indirectEval(thisContextSource(this._compiled, this._filename));
      } catch (err) {
        if (options?.displayErrors !== false) decorateThrown(err, this);
        throw err;
      }
    }
    runInContext(contextifiedObject) {
      if (contextifiedObject === null || typeof contextifiedObject !== 'object' || !contexts.has(contextifiedObject)) {
        throw ERR_INVALID_ARG_TYPE('contextifiedObject', 'vm.Context', contextifiedObject);
      }
      try {
        return runInScope(contextSource(this._code), contextifiedObject);
      } catch (err) {
        if (arguments[1]?.displayErrors !== false) decorateThrown(err, this);
        throw err;
      }
    }
    runInNewContext(contextObject, options) {
      return this.runInContext(createContext(contextObject, options));
    }
    createCachedData() {
      return globalThis.Buffer ? globalThis.Buffer.alloc(0) : new Uint8Array(0);
    }
    get sourceMapURL() {
      return /\/\/[#@] sourceMappingURL=(\S+)\s*$/.exec(this._code)?.[1];
    }
  }

  function isContext(object) {
    validateObject(object, 'object', kAllowObjects);
    return contexts.has(object);
  }

  function createContext(contextObject = {}, options) {
    if (contextObject === vm.constants.DONT_CONTEXTIFY) contextObject = {};
    if (options !== undefined) validateObject(options, 'options');
    validateObject(contextObject, 'contextObject', kAllowObjects);
    scopeOf(contextObject);
    return contextObject;
  }

  function compileFunction(code, params = [], options = {}) {
    validateString(code, 'code');
    // eslint-disable-next-line no-new-func
    const fn = new Function(...params, code);
    if (options?.parsingContext && isContext(options.parsingContext)) {
      const scope = scopeOf(options.parsingContext);
      // eslint-disable-next-line no-new-func
      const make = new Function('__jsh_vm_scope__', '__jsh_vm_params__', '__jsh_vm_code__', 'with (__jsh_vm_scope__) { return function (...args) { return Function(...__jsh_vm_params__, __jsh_vm_code__).apply(this, args); }; }');
      return make(scope, params, code);
    }
    return fn;
  }

  const vm = {
    Script,
    createScript: (code, options) => new Script(code, options),
    createContext,
    isContext,
    runInThisContext: (code, options) => new Script(code, optionsOf(options, 'evalmachine.<anonymous>')).runInThisContext(options),
    runInContext: (code, contextifiedObject, options) =>
      new Script(code, optionsOf(options, 'evalmachine.<anonymous>')).runInContext(contextifiedObject, options),
    runInNewContext: (code, contextObject, options) =>
      new Script(code, optionsOf(options, 'evalmachine.<anonymous>')).runInNewContext(contextObject, options),
    compileFunction,
    measureMemory() {
      return Promise.reject(nodeError(Error, 'ERR_NOT_SUPPORTED', 'slicc-jsh: vm.measureMemory is not supported (no V8 bindings)'));
    },
    constants: Object.freeze({
      __proto__: null,
      USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol('vm_dynamic_import_main_context_default'),
      DONT_CONTEXTIFY: Symbol('vm_context_no_contextify'),
    }),
  };
  return vm;
}

/** internal/vm's makeContextifyScript (lib/repl.js compiles with it). */
export function makeContextifyScriptWith(vm) {
  return function makeContextifyScript(code, filename, lineOffset, columnOffset, cachedData, produceCachedData, parsingContext, hostDefinedOptionId, importModuleDynamically) {
    return new vm.Script(code, { filename, lineOffset, columnOffset, cachedData, importModuleDynamically, [kInternalScript]: true });
  };
}

/**
 * displayErrors: an error thrown out of a script gets the arrow at its throw
 * site before its stack (Node's DecorateErrorStack). V8 knows the throw
 * statement; here it is the top frame's line, the caret under its `throw`.
 */
function decorateThrown(err, script) {
  if (!err || typeof err !== 'object' || err[kDecorated]) return;
  let stack;
  try {
    stack = err.stack;
  } catch {
    return;
  }
  if (typeof stack !== 'string') return;
  const top = /\n\s+at (?:.*?\()?([^()\s]+?):(\d+):(\d+)\)?(?:\n|$)/.exec(stack);
  if (!top || top[1] !== script._filename) return;
  const line = Number(top[2]);
  const text = script._code.split('\n')[line - 1 - script._lineOffset];
  if (text === undefined) return;
  const col = Number(top[3]) - 1;
  const at = text.lastIndexOf('throw', col);
  Object.defineProperty(err, kArrowMessage, {
    value: `${script._filename}:${line}\n${text}\n${' '.repeat(at === -1 ? Math.max(0, col) : at)}^\n`,
    configurable: true,
    writable: true,
  });
  decorateErrorStack(err);
}

/** internal/util's decorateErrorStack: the arrow V8 keeps on a SyntaxError, before its stack. */
export function decorateErrorStack(err) {
  if (!(err && typeof err === 'object' && err.stack) || err[kDecorated]) return;
  const arrow = err[kArrowMessage];
  if (arrow) {
    err.stack = `${arrow}\n${err.stack}`;
    Object.defineProperty(err, kDecorated, { value: true, configurable: true, writable: true });
  }
}
