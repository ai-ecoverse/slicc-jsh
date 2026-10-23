/**
 * ESM → executable body via acorn AST (not regex).
 * Imports are hoisted; export live-binding getters are registered before the
 * body (and before import evaluation) so cycles see the bindings.
 */
import * as acorn from 'acorn';
import { encodeFilePath } from '../builtins/url.mjs';
import { syntaxReport } from '../syntax-report.mjs';

// Node keeps [eval1]'s brackets in its URL (as stack.mjs does).
const fileUrlOf = (p) => {
  if (typeof p !== 'string' || !p.startsWith('/')) return p;
  if (p.endsWith('/[eval1]')) return `file://${encodeFilePath(p.slice(0, -8))}/[eval1]`;
  return `file://${encodeFilePath(p)}`;
};

function stripHashbang(source) {
  if (source.startsWith('#!')) {
    const nl = source.indexOf('\n');
    return nl === -1 ? '' : source.slice(nl + 1);
  }
  return source;
}

function applyReplacements(source, replacements) {
  const sorted = [...replacements].sort((a, b) => b.start - a.start);
  let out = source;
  for (const { start, end, text } of sorted) {
    out = out.slice(0, start) + text + out.slice(end);
  }
  return out;
}

function isFunctionLike(node) {
  return (
    node &&
    (node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression' ||
      node.type === 'ClassDeclaration' ||
      node.type === 'ClassExpression')
  );
}

/** Walk AST; skip descending into nested functions for TLA detection when skipNested. */
function walk(node, visitor, parent = null) {
  if (!node || typeof node !== 'object') return;
  visitor(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child.type === 'string') walk(child, visitor, node);
      }
    } else if (val && typeof val.type === 'string') {
      walk(val, visitor, node);
    }
  }
}

/**
 * @returns {{
 *   code: string,
 *   bodyCode: string,
 *   staticSpecs: string[],
 *   hasTopLevelAwait: boolean,
 *   exportSetup: string[],
 *   hoistImports: string[],
 * }}
 */
export function transformEsm(source, filename, sourceUrl = filename) {
  // A hashbang line goes, its newline stays (lines keep their numbers).
  const body = source.startsWith('#!') ? (source.includes('\n') ? source.slice(source.indexOf('\n')) : '') : source;
  let ast;
  try {
    ast = acorn.parse(body, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
    });
  } catch (err) {
    // Node's: V8's SyntaxError, reported at the file: URL's line, with carets.
    const report = err instanceof SyntaxError && syntaxReport(body, { kind: 'module', filename: fileUrlOf(filename) });
    if (report) {
      const e = new SyntaxError(report.message);
      Object.defineProperty(e, '_prettyStack', { value: report.stack, configurable: true, writable: true });
      e.stack = report.stack;
      throw e;
    }
    const e = err instanceof Error ? err : new Error(String(err));
    e.message = `${filename}: ${e.message}`;
    throw e;
  }

  const staticSpecs = [];
  // A static import's `with { … }` attributes, by specifier.
  const staticAttributes = Object.create(null);
  const attributesOf = (stmt) => {
    const list = stmt.attributes ?? stmt.assertions;
    if (!list?.length) return undefined;
    const out = {};
    for (const a of list) out[a.key.type === 'Identifier' ? a.key.name : a.key.value] = a.value.value;
    return out;
  };
  const importSyncCall = (spec, stmt) => {
    const attrs = attributesOf(stmt);
    if (attrs) staticAttributes[spec] = attrs;
    return `__importSync(${JSON.stringify(spec)}${attrs ? `, ${JSON.stringify(attrs)}` : ''})`;
  };
  const noteSpec = (spec) => {
    if (typeof spec === 'string' && !staticSpecs.includes(spec)) staticSpecs.push(spec);
  };

  /** @type {{ start: number, end: number, text: string }[]} */
  const replacements = [];
  const hoistImports = []; // code lines, evaluated after export getters are installed
  const exportSetup = []; // defineProperty getters — run BEFORE imports
  const exportNames = new Set();
  /** Local names bound as live getters on `__live` (named/default imports). */
  const liveLocals = new Set();

  let nsId = 0;
  const freshNs = () => `__ns${nsId++}`;

  const bindExport = (exportName, localExpr) => {
    if (exportNames.has(exportName)) return;
    exportNames.add(exportName);
    const expr =
      typeof localExpr === 'string' && liveLocals.has(localExpr)
        ? `__live[${JSON.stringify(localExpr)}]`
        : localExpr;
    exportSetup.push(
      `Object.defineProperty(__exports, ${JSON.stringify(exportName)}, { enumerable: true, configurable: true, get: () => (${expr}) });`
    );
  };

  const bindLive = (local, expr, namedCheck) => {
    liveLocals.add(local);
    if (namedCheck) hoistImports.push(namedCheck);
    hoistImports.push(
      `Object.defineProperty(__live, ${JSON.stringify(local)}, { enumerable: true, configurable: true, get: () => (${expr}) });`
    );
  };

  // --- Pass 1a: imports first (so liveLocals is known before export getters) ---
  for (const stmt of ast.body) {
    if (stmt.type !== 'ImportDeclaration') continue;
    const spec = stmt.source.value;
    noteSpec(spec);
    const ns = freshNs();
    hoistImports.push(`const ${ns} = ${importSyncCall(spec, stmt)};`);
    for (const s of stmt.specifiers) {
      if (s.type === 'ImportDefaultSpecifier') {
        // Live binding — do not snapshot (TDZ / import cycles).
        bindLive(s.local.name, `${ns}.default`);
      } else if (s.type === 'ImportNamespaceSpecifier') {
        hoistImports.push(`const ${s.local.name} = ${ns};`);
      } else if (s.type === 'ImportSpecifier') {
        const imported =
          s.imported.type === 'Identifier' ? s.imported.name : s.imported.value;
        // Node: missing named export from CJS (or ESM) is a SyntaxError at link.
        // (__importSync.missing words it as Node does for an ES or CommonJS module.)
        const namedCheck =
          `if (!Object.prototype.hasOwnProperty.call(${ns}, ${JSON.stringify(imported)})) ` +
          `__importSync.missing(${ns}, ${JSON.stringify(spec)}, ${JSON.stringify(imported)});`;
        bindLive(s.local.name, `${ns}[${JSON.stringify(imported)}]`, namedCheck);
      }
    }
    replacements.push({ start: stmt.start, end: stmt.end, text: '' });
  }

  // --- Pass 1b: export declarations ---
  for (const stmt of ast.body) {
    if (stmt.type === 'ImportDeclaration') continue;

    if (stmt.type === 'ExportAllDeclaration') {
      const spec = stmt.source.value;
      noteSpec(spec);
      const ns = freshNs();
      // Load during import phase (after getters for *local* exports exist).
      hoistImports.push(`const ${ns} = ${importSyncCall(spec, stmt)};`);
      if (stmt.exported) {
        // export * as ns from 'x'
        const name = stmt.exported.name;
        bindExport(name, ns);
      } else {
        // export * from 'x' — star exports linked after load
        hoistImports.push(
          `for (const __k of Object.keys(${ns})) { if (__k !== 'default' && !Object.prototype.hasOwnProperty.call(__exports, __k)) Object.defineProperty(__exports, __k, { enumerable: true, configurable: true, get: () => ${ns}[__k] }); }`
        );
      }
      replacements.push({ start: stmt.start, end: stmt.end, text: '' });
      continue;
    }

    if (stmt.type === 'ExportDefaultDeclaration') {
      const d = stmt.declaration;
      if (
        (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') &&
        d.id
      ) {
        // export default function name() {} → keep declaration; only default is exported.
        replacements.push({ start: stmt.start, end: d.start, text: '' });
        bindExport('default', d.id.name);
      } else if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') {
        // anonymous default — expression form (handles async function / class).
        // Only the `export default` and the end are rewritten, so what is
        // inside (import.meta, import(), live bindings) is rewritten as anywhere.
        const syn = `__default_${exportSetup.length}`;
        replacements.push({ start: stmt.start, end: d.start, text: `const ${syn} = (` });
        replacements.push({ start: d.end, end: stmt.end, text: ');' });
        bindExport('default', syn);
      } else {
        // export default expr;
        const syn = `__default_${exportSetup.length}`;
        replacements.push({ start: stmt.start, end: d.start, text: `var ${syn} = (` });
        replacements.push({ start: d.end, end: stmt.end, text: ');' });
        bindExport('default', syn);
      }
      continue;
    }

    if (stmt.type === 'ExportNamedDeclaration') {
      if (stmt.source) {
        // export { a, b as c } from 'x'
        const spec = stmt.source.value;
        noteSpec(spec);
        const ns = freshNs();
        hoistImports.push(`const ${ns} = ${importSyncCall(spec, stmt)};`);
        for (const s of stmt.specifiers) {
          const exported =
            s.exported.type === 'Identifier' ? s.exported.name : s.exported.value;
          const local =
            s.local.type === 'Identifier' ? s.local.name : s.local.value;
          bindExport(exported, `${ns}[${JSON.stringify(local)}]`);
        }
        replacements.push({ start: stmt.start, end: stmt.end, text: '' });
        continue;
      }

      if (stmt.declaration) {
        const d = stmt.declaration;
        // Strip leading "export "
        replacements.push({ start: stmt.start, end: d.start, text: '' });
        if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') {
          if (d.id) bindExport(d.id.name, d.id.name);
        } else if (d.type === 'VariableDeclaration') {
          for (const decl of d.declarations) {
            collectBoundNames(decl.id, (name) => bindExport(name, name));
          }
        }
        continue;
      }

      // export { a, b as c }
      for (const s of stmt.specifiers) {
        const exported =
          s.exported.type === 'Identifier' ? s.exported.name : s.exported.value;
        const local = s.local.type === 'Identifier' ? s.local.name : s.local.value;
        bindExport(exported, local);
      }
      replacements.push({ start: stmt.start, end: stmt.end, text: '' });
    }
  }

  // --- Pass 2: rewrite import.meta and import() anywhere (AST-accurate) ---
  walk(ast, (node) => {
    if (
      node.type === 'MetaProperty' &&
      node.meta.type === 'Identifier' &&
      node.meta.name === 'import' &&
      node.property.name === 'meta'
    ) {
      replacements.push({ start: node.start, end: node.end, text: '__meta' });
      return;
    }
    if (node.type === 'ImportExpression') {
      // import(expr) → __import(expr)
      replacements.push({
        start: node.start,
        end: node.source.start,
        text: '__import(',
      });
    }
  });

  // Top-level await
  let hasTopLevelAwait = false;
  const checkTla = (node, parent) => {
    if (node.type !== 'AwaitExpression') return;
    let p = parent;
    // Walk up via a second pass — simpler: scan program body statements only
  };
  void checkTla;
  for (const stmt of ast.body) {
    walkTopLevelAwait(stmt, (found) => {
      if (found) hasTopLevelAwait = true;
    });
  }

  // Rewrite free references to imported locals → `__live.name` (live bindings).
  if (liveLocals.size) {
    rewriteLiveIdentifiers(ast, liveLocals, replacements);
    hoistImports.unshift('const __live = Object.create(null);');
  }

  // Keep every line where it was, so stack frames name the file's own lines:
  // a removed or rewritten statement leaves its newlines behind.
  // Shorter replacements are padded with spaces, so what follows on the line
  // keeps its column too.
  const newlines = (t) => (t.match(/\n/g) || []).length;
  // Longer one-line replacements (`__live["x"]` for an import) push the rest
  // of their line right: per line, [start, end, growth] for stack.mjs to map
  // a frame's column back to the file's.
  const columnShifts = {};
  for (const r of replacements) {
    const span = body.slice(r.start, r.end);
    if (!span.includes('\n') && !r.text.includes('\n') && r.text.length > span.length) {
      const lineStart = body.lastIndexOf('\n', r.start - 1) + 1;
      const line = newlines(body.slice(0, r.start)) + 1;
      // A call of an import, `(0, __live["f"])(…)`: V8 names the `(` after it.
      const called = r.text.startsWith('(0, __live[') ? 1 : 0;
      (columnShifts[line] ??= []).push([r.start - lineStart, r.end - lineStart, r.text.length - span.length, called]);
    }
  }
  for (const list of Object.values(columnShifts)) list.sort((a, b) => a[0] - b[0]);
  for (const r of replacements) {
    const span = body.slice(r.start, r.end);
    const lost = newlines(span) - newlines(r.text);
    if (lost > 0) r.text += '\n'.repeat(lost);
    const tailOf = (t, startCol) => (t.includes('\n') ? t.length - t.lastIndexOf('\n') - 1 : startCol + t.length);
    const startCol = r.start - (body.lastIndexOf('\n', r.start - 1) + 1);
    const pad = tailOf(span, startCol) - tailOf(r.text, startCol);
    if (pad > 0) r.text += ' '.repeat(pad);
  }
  const code = applyReplacements(body, replacements);

  const preamble = [...exportSetup, ...hoistImports].join('\n');
  const out = `${preamble ? preamble + '\n' : ''}${code}\n//# sourceURL=${sourceUrl}\n`;
  return {
    code: out,
    // Lines `code` puts before the module's own first line.
    preambleLines: preamble ? newlines(preamble) + 1 : 0,
    columnShifts,
    bodyCode: code,
    staticSpecs,
    staticAttributes,
    hasTopLevelAwait,
    exportSetup,
    hoistImports,
  };
}

/** True when Identifier is a value reference (not a declaration / property key). */
function isValueReference(node, parent) {
  if (!parent) return false;
  if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) {
    return false;
  }
  // Object/class property key (including shorthand — key and value are the
  // same node), a class field's or auto-accessor's key among them.
  if (
    parent.type === 'Property' ||
    parent.type === 'MethodDefinition' ||
    parent.type === 'PropertyDefinition' ||
    parent.type === 'AccessorProperty'
  ) {
    if (parent.key === node && !parent.computed) return false;
    // Shorthand `{ x }` must expand to `{ x: __live["x"] }`, not `{ __live["x"] }`.
    if (parent.shorthand && parent.value === node) return false;
  }
  if (parent.type === 'LabeledStatement' && parent.label === node) return false;
  // `import.meta`, `new.target`: names, not bindings.
  if (parent.type === 'MetaProperty') return false;
  if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier') {
    return false;
  }
  if (parent.type === 'ExportSpecifier' && (parent.exported === node || parent.local === node)) {
    return false;
  }
  if (parent.type === 'VariableDeclarator' && parent.id === node) return false;
  if (
    (parent.type === 'FunctionDeclaration' ||
      parent.type === 'FunctionExpression' ||
      parent.type === 'ClassDeclaration' ||
      parent.type === 'ClassExpression') &&
    parent.id === node
  ) {
    return false;
  }
  // Function/catch parameter bindings (not default-value expressions).
  if (
    (parent.type === 'FunctionDeclaration' ||
      parent.type === 'FunctionExpression' ||
      parent.type === 'ArrowFunctionExpression') &&
    parent.params.includes(node)
  ) {
    return false;
  }
  if (parent.type === 'CatchClause' && parent.param === node) return false;
  if (parent.type === 'AssignmentPattern' && parent.left === node) return false;
  if (parent.type === 'RestElement' && parent.argument === node) return false;
  if (parent.type === 'ArrayPattern' && parent.elements.includes(node)) return false;
  if (parent.type === 'AssignmentExpression' && parent.left === node) {
    // Still a reference (assign to import is invalid, but rewrite anyway).
    return true;
  }
  return true;
}

/**
 * Replace free Identifier refs to imported live locals with `__live["name"]`.
 * Respects function/block shadowing.
 */
function rewriteLiveIdentifiers(ast, liveLocals, replacements) {
  const visit = (node, parent, shadows) => {
    if (!node || typeof node !== 'object') return;
    // Expand `{ x }` / `{ x, y }` shorthand when `x` is an imported live binding.
    // Skip ObjectPattern / destructuring bindings (those shadow the import).
    if (node.type === 'Property' && node.shorthand && node.key?.type === 'Identifier') {
      const name = node.key.name;
      if (
        liveLocals.has(name) &&
        !shadows.has(name) &&
        parent?.type !== 'ObjectPattern'
      ) {
        replacements.push({
          start: node.start,
          end: node.end,
          text: `${name}: __live[${JSON.stringify(name)}]`,
        });
        return; // do not walk into key/value (same Identifier)
      }
    }
    if (node.type === 'Identifier') {
      if (
        liveLocals.has(node.name) &&
        !shadows.has(node.name) &&
        isValueReference(node, parent)
      ) {
        // A call of an imported function has no receiver (its `this` is
        // undefined, as in Node), not the live-bindings object.
        const called =
          (parent?.type === 'CallExpression' && parent.callee === node) ||
          (parent?.type === 'TaggedTemplateExpression' && parent.tag === node);
        const ref = `__live[${JSON.stringify(node.name)}]`;
        replacements.push({
          start: node.start,
          end: node.end,
          text: called ? `(0, ${ref})` : ref,
        });
      }
      return;
    }

    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      const inner = new Set(shadows);
      if (node.id?.name) inner.add(node.id.name);
      for (const p of node.params) collectBoundNames(p, (n) => inner.add(n));
      // Params (and their destructuring bindings) shadow imports — visit with
      // `inner` so `function (func) {}` is not rewritten to `__live["func"]`.
      // Default-value expressions still rewrite free refs not in `inner`.
      if (node.id) visit(node.id, node, inner);
      for (const p of node.params) visit(p, node, inner);
      visit(node.body, node, inner);
      return;
    }

    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      const inner = new Set(shadows);
      if (node.id?.name) inner.add(node.id.name);
      if (node.id) visit(node.id, node, shadows);
      if (node.superClass) visit(node.superClass, node, shadows);
      visit(node.body, node, inner);
      return;
    }

    if (node.type === 'BlockStatement') {
      const inner = new Set(shadows);
      for (const stmt of node.body) {
        if (stmt.type === 'VariableDeclaration') {
          for (const d of stmt.declarations) collectBoundNames(d.id, (n) => inner.add(n));
        } else if (stmt.type === 'FunctionDeclaration' && stmt.id) {
          inner.add(stmt.id.name);
        } else if (stmt.type === 'ClassDeclaration' && stmt.id) {
          inner.add(stmt.id.name);
        }
      }
      for (const stmt of node.body) visit(stmt, node, inner);
      return;
    }

    if (node.type === 'CatchClause') {
      const inner = new Set(shadows);
      if (node.param) collectBoundNames(node.param, (n) => inner.add(n));
      if (node.param) visit(node.param, node, inner);
      visit(node.body, node, inner);
      return;
    }

    for (const key of Object.keys(node)) {
      if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
      const val = node[key];
      if (Array.isArray(val)) {
        for (const child of val) {
          if (child && typeof child.type === 'string') visit(child, node, shadows);
        }
      } else if (val && typeof val.type === 'string') {
        visit(val, node, shadows);
      }
    }
  };

  // Program: collect top-level function/class/var names that shadow imports.
  const topShadows = new Set();
  for (const stmt of ast.body) {
    if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations) collectBoundNames(d.id, (n) => topShadows.add(n));
    } else if (stmt.type === 'FunctionDeclaration' && stmt.id) {
      topShadows.add(stmt.id.name);
    } else if (stmt.type === 'ClassDeclaration' && stmt.id) {
      topShadows.add(stmt.id.name);
    }
  }
  for (const stmt of ast.body) {
    // Skip import/export declarations (already removed / handled).
    if (
      stmt.type === 'ImportDeclaration' ||
      stmt.type === 'ExportAllDeclaration' ||
      stmt.type === 'ExportNamedDeclaration' ||
      stmt.type === 'ExportDefaultDeclaration'
    ) {
      // Walk export declaration bodies that remain in the source (pass 1
      // rewrites only the `export …` around them).
      if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) {
        visit(stmt.declaration, stmt, topShadows);
      } else if (stmt.type === 'ExportDefaultDeclaration') {
        // A bare `export default x` is an expression: its parent for
        // isValueReference is an expression statement's.
        const d = stmt.declaration;
        visit(d, d.type === 'Identifier' ? { type: 'ExpressionStatement', expression: d } : stmt, topShadows);
      }
      continue;
    }
    visit(stmt, ast, topShadows);
  }
}

function collectBoundNames(pattern, onName) {
  if (!pattern) return;
  if (pattern.type === 'Identifier') {
    onName(pattern.name);
    return;
  }
  if (pattern.type === 'ObjectPattern') {
    for (const prop of pattern.properties) {
      if (prop.type === 'RestElement') collectBoundNames(prop.argument, onName);
      else collectBoundNames(prop.value, onName);
    }
    return;
  }
  if (pattern.type === 'ArrayPattern') {
    for (const el of pattern.elements) {
      if (el) collectBoundNames(el, onName);
    }
    return;
  }
  if (pattern.type === 'AssignmentPattern') {
    collectBoundNames(pattern.left, onName);
  }
}

function walkTopLevelAwait(node, report) {
  if (!node || typeof node !== 'object') return;
  if (isFunctionLike(node) && node.type !== 'Program') {
    // Don't look inside functions/classes for TLA
    return;
  }
  // `await x`, and `for await (…)` (a ForOfStatement, no AwaitExpression).
  if (node.type === 'AwaitExpression' || (node.type === 'ForOfStatement' && node.await)) {
    report(true);
    return;
  }
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'loc') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child.type === 'string') walkTopLevelAwait(child, report);
      }
    } else if (val && typeof val.type === 'string') {
      // Enter class/function bodies? No — skip function-like children entirely
      if (isFunctionLike(val)) continue;
      walkTopLevelAwait(val, report);
    }
  }
}

/**
 * Collect binding names that would collide with a Function parameter.
 * @param {import('acorn').Node} ast
 * @returns {Set<string>}
 */
function collectScriptBindingNames(ast) {
  const used = new Set();
  const add = (name) => {
    if (typeof name === 'string') used.add(name);
  };
  const addPattern = (pattern) => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') add(pattern.name);
    else if (pattern.type === 'ObjectPattern') {
      for (const prop of pattern.properties) {
        if (prop.type === 'RestElement') addPattern(prop.argument);
        else addPattern(prop.value);
      }
    } else if (pattern.type === 'ArrayPattern') {
      for (const el of pattern.elements) if (el) addPattern(el);
    } else if (pattern.type === 'AssignmentPattern') addPattern(pattern.left);
    else if (pattern.type === 'RestElement') addPattern(pattern.argument);
  };
  walk(ast, (node) => {
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      if (node.id) add(node.id.name);
      for (const p of node.params) addPattern(p);
      return;
    }
    if (node.type === 'VariableDeclarator') addPattern(node.id);
    if (node.type === 'ClassDeclaration' && node.id) add(node.id.name);
    if (node.type === 'CatchClause' && node.param) addPattern(node.param);
  });
  return used;
}

/**
 * Rewrite dynamic `import(expr)` → `<binding>(expr)` for CJS evaluation.
 * Picks a binding that does not collide with declarations in the script
 * (`__import`, then `__import$1`, …).
 * Returns `{ code, changed, binding? }`. No-op when there are no ImportExpressions.
 */
export function rewriteDynamicImports(source, { callee } = {}) {
  const body = stripHashbang(source);
  let ast;
  try {
    ast = acorn.parse(body, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: false,
    });
  } catch {
    return { code: source, changed: false };
  }
  /** @type {{ start: number, end: number, text: string }[]} */
  const replacements = [];
  walk(ast, (node) => {
    if (node.type === 'ImportExpression') {
      replacements.push({
        start: node.start,
        end: node.source.start,
        text: '\0IMPORT(', // placeholder; binding filled below
      });
    }
  });
  if (replacements.length === 0) return { code: source, changed: false };

  const used = collectScriptBindingNames(ast);
  let binding = callee ?? '__import';
  let n = 0;
  while (!callee && used.has(binding)) binding = `__import$${++n}`;
  for (const r of replacements) r.text = `${binding}(`;

  return { code: applyReplacements(body, replacements), changed: true, binding };
}

/**
 * Node-style module detection (detect-module): run as CJS unless the source
 * contains ESM-only syntax. Dynamic `import()` alone is valid in CommonJS.
 *
 * Try parse as a script; if that fails, accept as ESM when it parses as a
 * module (static import/export, import.meta, or top-level await).
 */
export function shouldRunAsEsm(source) {
  const body = stripHashbang(source);
  try {
    acorn.parse(body, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: false,
    });
    return false;
  } catch {
    /* try module */
  }
  try {
    acorn.parse(body, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
    });
    return true;
  } catch {
    return false;
  }
}

/** @deprecated use shouldRunAsEsm — kept as alias for call sites */
export function sourceLooksLikeEsm(source) {
  return shouldRunAsEsm(source);
}
