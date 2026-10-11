/**
 * Lightweight ESM → executable body transform for slicc-jsh.
 * Static imports become __importSync(spec) calls; dynamic import() → __import().
 * Exports are assigned onto __exports. import.meta → __meta.
 */

function unquote(s) {
  return s.slice(1, -1);
}

function parseNamedList(list) {
  return list
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(p);
      if (!m) return null;
      return { name: m[1], as: m[2] || m[1] };
    })
    .filter(Boolean);
}

function stripHashbang(source) {
  if (source.startsWith('#!')) {
    const nl = source.indexOf('\n');
    return nl === -1 ? '' : source.slice(nl + 1);
  }
  return source;
}

function rewriteInline(line) {
  return line.replace(/\bimport\.meta\b/g, '__meta').replace(/\bimport\s*\(/g, '__import(');
}

/**
 * @returns {{ code: string, staticSpecs: string[], hasTopLevelAwait: boolean }}
 */
export function transformEsm(source, filename) {
  const body = stripHashbang(source);
  const lines = body.split('\n');
  const out = [];
  const staticSpecs = [];
  let hasTopLevelAwait = false;
  let depth = 0;
  let nsId = 0;

  const noteSpec = (spec) => {
    if (!staticSpecs.includes(spec)) staticSpecs.push(spec);
  };

  const freshNs = () => `__ns${nsId++}`;

  for (const line of lines) {
    const trimmed = line.trim();
    const isImportExport = trimmed.startsWith('import ') || trimmed.startsWith('export ');

    if (depth > 0 || !isImportExport) {
      for (const ch of line) {
        if (ch === '{') depth++;
        else if (ch === '}') depth = Math.max(0, depth - 1);
      }
      if (depth === 0 && /(^|[^\w.$])await\s/.test(line)) hasTopLevelAwait = true;
      out.push(rewriteInline(line));
      continue;
    }

    let m;

    if ((m = /^import\s+('[^']+'|"[^"]+")\s*;?$/.exec(trimmed))) {
      const spec = unquote(m[1]);
      noteSpec(spec);
      out.push(`void __importSync(${JSON.stringify(spec)});`);
      continue;
    }

    if (
      (m = /^import\s+(\w+)\s*,\s*\*\s*as\s+(\w+)\s+from\s+('[^']+'|"[^"]+")\s*;?$/.exec(trimmed))
    ) {
      const spec = unquote(m[3]);
      const ns = freshNs();
      noteSpec(spec);
      out.push(`const ${ns} = __importSync(${JSON.stringify(spec)});`);
      out.push(`const ${m[1]} = ${ns}.default;`);
      out.push(`const ${m[2]} = ${ns};`);
      continue;
    }

    if (
      (m = /^import\s+(\w+)\s*,\s*\{([^}]+)\}\s+from\s+('[^']+'|"[^"]+")\s*;?$/.exec(trimmed))
    ) {
      const spec = unquote(m[3]);
      const ns = freshNs();
      noteSpec(spec);
      out.push(`const ${ns} = __importSync(${JSON.stringify(spec)});`);
      out.push(`const ${m[1]} = ${ns}.default;`);
      for (const { name, as } of parseNamedList(m[2])) {
        out.push(`const ${as} = ${ns}[${JSON.stringify(name)}];`);
      }
      continue;
    }

    if ((m = /^import\s+\*\s*as\s+(\w+)\s+from\s+('[^']+'|"[^"]+")\s*;?$/.exec(trimmed))) {
      const spec = unquote(m[2]);
      noteSpec(spec);
      out.push(`const ${m[1]} = __importSync(${JSON.stringify(spec)});`);
      continue;
    }

    if ((m = /^import\s+\{([^}]+)\}\s+from\s+('[^']+'|"[^"]+")\s*;?$/.exec(trimmed))) {
      const spec = unquote(m[2]);
      const ns = freshNs();
      noteSpec(spec);
      out.push(`const ${ns} = __importSync(${JSON.stringify(spec)});`);
      for (const { name, as } of parseNamedList(m[1])) {
        out.push(`const ${as} = ${ns}[${JSON.stringify(name)}];`);
      }
      continue;
    }

    if ((m = /^import\s+(\w+)\s+from\s+('[^']+'|"[^"]+")\s*;?$/.exec(trimmed))) {
      const spec = unquote(m[2]);
      noteSpec(spec);
      out.push(`const ${m[1]} = __importSync(${JSON.stringify(spec)}).default;`);
      continue;
    }

    if ((m = /^export\s+\*\s+as\s+(\w+)\s+from\s+('[^']+'|"[^"]+")\s*;?$/.exec(trimmed))) {
      const spec = unquote(m[2]);
      noteSpec(spec);
      out.push(
        `Object.defineProperty(__exports, ${JSON.stringify(m[1])}, { enumerable: true, configurable: true, get: () => __importSync(${JSON.stringify(spec)}) });`
      );
      continue;
    }

    if ((m = /^export\s+\*\s+from\s+('[^']+'|"[^"]+")\s*;?$/.exec(trimmed))) {
      const spec = unquote(m[1]);
      const ns = freshNs();
      noteSpec(spec);
      out.push(`const ${ns} = __importSync(${JSON.stringify(spec)});`);
      out.push(
        `for (const __k of Object.keys(${ns})) { if (__k !== 'default') Object.defineProperty(__exports, __k, { enumerable: true, configurable: true, get: () => ${ns}[__k] }); }`
      );
      continue;
    }

    if ((m = /^export\s+\{([^}]+)\}\s+from\s+('[^']+'|"[^"]+")\s*;?$/.exec(trimmed))) {
      const spec = unquote(m[2]);
      const ns = freshNs();
      noteSpec(spec);
      out.push(`const ${ns} = __importSync(${JSON.stringify(spec)});`);
      for (const { name, as } of parseNamedList(m[1])) {
        out.push(
          `Object.defineProperty(__exports, ${JSON.stringify(as)}, { enumerable: true, configurable: true, get: () => ${ns}[${JSON.stringify(name)}] });`
        );
      }
      continue;
    }

    if ((m = /^export\s+\{([^}]+)\}\s*;?$/.exec(trimmed))) {
      for (const { name, as } of parseNamedList(m[1])) {
        out.push(
          `Object.defineProperty(__exports, ${JSON.stringify(as)}, { enumerable: true, configurable: true, get: () => ${name} });`
        );
      }
      continue;
    }

    if ((m = /^export\s+default\s+/.exec(trimmed))) {
      const rest = trimmed.slice(m[0].length).replace(/;?\s*$/, '');
      out.push(`__exports.default = (${rest});`);
      continue;
    }

    if ((m = /^export\s+(async\s+)?(function\*?|class)\s+(\w+)/.exec(trimmed))) {
      const name = m[3];
      out.push(trimmed.slice('export '.length));
      out.push(
        `Object.defineProperty(__exports, ${JSON.stringify(name)}, { enumerable: true, configurable: true, get: () => ${name} });`
      );
      continue;
    }
    if ((m = /^export\s+(const|let|var)\s+/.exec(trimmed))) {
      const rest = trimmed.slice(m[0].length);
      out.push(`${m[1]} ${rest}`);
      for (const part of rest.split(',')) {
        const id = /^\s*(\w+)/.exec(part)?.[1];
        if (!id) continue;
        out.push(
          `Object.defineProperty(__exports, ${JSON.stringify(id)}, { enumerable: true, configurable: true, get: () => ${id} });`
        );
      }
      continue;
    }

    out.push(rewriteInline(line));
  }

  return {
    code: `${out.join('\n')}\n//# sourceURL=${filename}\n`,
    staticSpecs,
    hasTopLevelAwait,
  };
}

/** True if source looks like an ES module (static import/export). */
export function sourceLooksLikeEsm(source) {
  const stripped = stripHashbang(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  return /^\s*(?:import\s|export\s)/m.test(stripped);
}
