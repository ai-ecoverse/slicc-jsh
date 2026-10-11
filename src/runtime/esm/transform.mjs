/**
 * ESM → executable body via acorn AST (not regex).
 * Imports are hoisted; export live-binding getters are registered before the
 * body (and before import evaluation) so cycles see the bindings.
 */
import * as acorn from 'acorn';

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
 * @returns {{ code: string, staticSpecs: string[], hasTopLevelAwait: boolean }}
 */
export function transformEsm(source, filename) {
  const body = stripHashbang(source);
  let ast;
  try {
    ast = acorn.parse(body, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
    });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    e.message = `${filename}: ${e.message}`;
    throw e;
  }

  const staticSpecs = [];
  const noteSpec = (spec) => {
    if (typeof spec === 'string' && !staticSpecs.includes(spec)) staticSpecs.push(spec);
  };

  /** @type {{ start: number, end: number, text: string }[]} */
  const replacements = [];
  const hoistImports = []; // code lines, evaluated after export getters are installed
  const exportSetup = []; // defineProperty getters — run BEFORE imports
  const exportNames = new Set();

  let nsId = 0;
  const freshNs = () => `__ns${nsId++}`;

  const bindExport = (exportName, localExpr) => {
    if (exportNames.has(exportName)) return;
    exportNames.add(exportName);
    exportSetup.push(
      `Object.defineProperty(__exports, ${JSON.stringify(exportName)}, { enumerable: true, configurable: true, get: () => (${localExpr}) });`
    );
  };

  // --- Pass 1: top-level import / export declarations ---
  for (const stmt of ast.body) {
    if (stmt.type === 'ImportDeclaration') {
      const spec = stmt.source.value;
      noteSpec(spec);
      const ns = freshNs();
      hoistImports.push(`const ${ns} = __importSync(${JSON.stringify(spec)});`);
      for (const s of stmt.specifiers) {
        if (s.type === 'ImportDefaultSpecifier') {
          hoistImports.push(`const ${s.local.name} = ${ns}.default;`);
        } else if (s.type === 'ImportNamespaceSpecifier') {
          hoistImports.push(`const ${s.local.name} = ${ns};`);
        } else if (s.type === 'ImportSpecifier') {
          const imported =
            s.imported.type === 'Identifier' ? s.imported.name : s.imported.value;
          hoistImports.push(
            `const ${s.local.name} = ${ns}[${JSON.stringify(imported)}];`
          );
        }
      }
      replacements.push({ start: stmt.start, end: stmt.end, text: '' });
      continue;
    }

    if (stmt.type === 'ExportAllDeclaration') {
      const spec = stmt.source.value;
      noteSpec(spec);
      const ns = freshNs();
      // Load during import phase (after getters for *local* exports exist).
      hoistImports.push(`const ${ns} = __importSync(${JSON.stringify(spec)});`);
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
        const syn = `__default_${exportSetup.length}`;
        replacements.push({
          start: stmt.start,
          end: stmt.end,
          text: `const ${syn} = (${body.slice(d.start, d.end)});`,
        });
        bindExport('default', syn);
      } else {
        // export default expr;
        const syn = `__default_${exportSetup.length}`;
        replacements.push({
          start: stmt.start,
          end: stmt.end,
          text: `var ${syn} = (${body.slice(d.start, d.end)});`,
        });
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
        hoistImports.push(`const ${ns} = __importSync(${JSON.stringify(spec)});`);
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

  let code = applyReplacements(body, replacements);
  // Drop leftover empty lines from removed imports (cosmetic)
  code = code.replace(/\n{3,}/g, '\n\n');

  const preamble = [...exportSetup, ...hoistImports].join('\n');
  const out = `${preamble ? preamble + '\n' : ''}${code}\n//# sourceURL=${filename}\n`;
  return { code: out, staticSpecs, hasTopLevelAwait };
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
  if (node.type === 'AwaitExpression') {
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
 * Rewrite dynamic `import(expr)` → `__import(expr)` for CJS evaluation.
 * Returns `{ code, changed }`. No-op when there are no ImportExpressions.
 */
export function rewriteDynamicImports(source) {
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
        text: '__import(',
      });
    }
  });
  if (replacements.length === 0) return { code: source, changed: false };
  return { code: applyReplacements(body, replacements), changed: true };
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
