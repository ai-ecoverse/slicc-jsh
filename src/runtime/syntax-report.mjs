/**
 * Node's report of a SyntaxError in a script, a CommonJS module, an ES
 * module or a `.jsh` body: `file:line`, the source line, carets under the
 * offending token, a blank line, then `SyntaxError: <V8's message>`.
 *
 * acorn finds the place (V8 doesn't say where a Function-constructor parse
 * failed); the message is V8's own, from compiling the same source with the
 * constructor that parses it the same way, where that tells (anything but
 * an ES module's import/export syntax), else acorn's in V8's words.
 */
import * as acorn from 'acorn';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const atEnd = (code, pos) => code.slice(pos).trim() === '';

/**
 * A module's source with its import / export syntax rewritten in place, every
 * position kept, so a Function body compiles it for V8's message about
 * everything else. acorn's tokens find the declarations (to the error, if one
 * stops it):
 * - `import … from '…' [with {…}];` becomes `let <its local names>;` (so a
 *   later redeclaration is still one), a bare `import '…';` nothing;
 * - `export {…} [from '…']`, `export * [as n] from '…'`: nothing;
 * - `export` before a declaration: nothing; `export default X`: `void X`
 *   (a function or class without a name stays valid);
 * - `import.meta`: an object.
 */
function withoutModuleSyntax(source) {
  const tokens = [];
  try {
    const t = acorn.tokenizer(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
    for (let tok = t.getToken(); tok.type !== acorn.tokTypes.eof; tok = t.getToken()) tokens.push(tok);
  } catch {
    /* the error: what came before it is enough */
  }
  const out = source.split('');
  const put = (start, end, text = '') => {
    for (let i = start; i < end; i++) if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
    // The replacement goes where the span starts (it is never longer).
    for (let i = 0; i < text.length; i++) out[start + i] = text[i];
  };
  const tt = acorn.tokTypes;
  const word = (tok, w) => tok && (tok.type === tt.name || tok.type.keyword !== undefined) && tok.value === w;
  // The end of a module request: its string, then `with {…}` / `assert {…}`.
  const afterRequest = (i) => {
    if (tokens[i]?.type !== tt.string) return i;
    i++;
    if ((word(tokens[i], 'with') || word(tokens[i], 'assert')) && tokens[i + 1]?.type === tt.braceL) {
      i += 2;
      while (i < tokens.length && tokens[i].type !== tt.braceR) i++;
      i++;
    }
    return i;
  };
  const semi = (i) => (tokens[i]?.type === tt.semi ? i + 1 : i);
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const type = tok.type;
    if (type === tt.braceL || type === tt.dollarBraceL) depth++;
    else if (type === tt.braceR) depth = Math.max(0, depth - 1);
    if (type === tt._import && tokens[i + 1]?.type === tt.dot) {
      // import.meta
      if (word(tokens[i + 2], 'meta')) put(tok.start, tokens[i + 2].end, '({})');
      continue;
    }
    if (depth !== 0) continue;
    if (type === tt._import && tokens[i + 1]?.type !== tt.parenL) {
      let j = i + 1;
      const names = [];
      while (j < tokens.length && !word(tokens[j], 'from') && tokens[j].type !== tt.string) {
        const cur = tokens[j];
        // A local name: the identifier before `,`, `}` or `from`, or after `as`.
        if (cur.type === tt.name && cur.value !== 'as' && !word(tokens[j + 1], 'as')) names.push(cur.value);
        j++;
      }
      if (word(tokens[j], 'from')) j++;
      const end = semi(afterRequest(j));
      if (end <= j) continue;
      put(tok.start, tokens[end - 1].end, names.length ? `let ${names.join(',')};` : '');
      i = end - 1;
      continue;
    }
    if (type === tt._export) {
      const next = tokens[i + 1];
      if (next?.type === tt._default) {
        put(tok.start, next.end, 'void');
        i++;
      } else if (next?.type === tt.braceL || next?.type === tt.star) {
        let j = i + 1;
        if (next.type === tt.braceL) {
          while (j < tokens.length && tokens[j].type !== tt.braceR) j++;
          j++;
        } else {
          j++;
          if (word(tokens[j], 'as')) j += 2;
        }
        if (word(tokens[j], 'from')) j = afterRequest(j + 1);
        const end = semi(j);
        put(tok.start, tokens[end - 1]?.end ?? source.length);
        i = end - 1;
      } else {
        put(tok.start, tok.end);
      }
    }
  }
  return out.join('');
}

/**
 * The span V8 marks for an error at acorn's `pos`, as [start, end].
 * - A token V8 could read: that token.
 * - An invalid one ("Invalid or unexpected token", a regular expression):
 *   V8 marks from where the token starts (acorn points past its start, as in
 *   `0x`, `1n2`, `#`, `/ab`) up to where its scanner gave up — an escape
 *   (`\u{110000}`) to its end, a string or template to the line's end, a
 *   regular expression its first character.
 */
const WORDISH = /[\w$\\{}]/;

/**
 * V8 marks a redeclaring function declaration at its first character and a
 * class declaration whole (acorn points at the name). Null for anything else.
 */
function declarationSpan(code, pos) {
  const before = code.slice(0, pos);
  const fn = /(?:\basync\s+)?\bfunction\s*(?:\*\s*)?$/.exec(before);
  if (fn) return [fn.index, fn.index + 1];
  const cls = /\bclass\s+$/.exec(before);
  if (!cls) return null;
  try {
    const t = acorn.tokenizer(code.slice(cls.index), { ecmaVersion: 'latest' });
    let depth = 0;
    for (let tok = t.getToken(); tok.type !== acorn.tokTypes.eof; tok = t.getToken()) {
      if (tok.type === acorn.tokTypes.braceL || tok.type === acorn.tokTypes.dollarBraceL) depth++;
      else if (tok.type === acorn.tokTypes.braceR && --depth === 0) return [cls.index, cls.index + tok.end];
    }
  } catch {
    /* unbalanced: acorn's place */
  }
  return null;
}
function markSpan(code, pos, message) {
  const invalid = /^(Invalid or unexpected token|Invalid regular expression|Undefined Unicode code-point|Invalid (Unicode|hexadecimal) escape sequence)/.test(
    message
  );
  if (/has already been declared$/.test(message)) {
    const decl = declarationSpan(code, pos);
    if (decl) return decl;
  }
  // V8 marks the `await` itself (acorn stops at what follows it).
  if (/^await is only valid/.test(message)) {
    const at = code.lastIndexOf('await', pos);
    if (at !== -1 && /^\s*$/.test(code.slice(at + 5, pos))) return [at, at + 5];
  }
  if (!invalid) {
    try {
      const t = acorn.tokenizer(code.slice(pos), { ecmaVersion: 'latest', allowHashBang: true }).getToken();
      if (t.end > t.start) return [pos + t.start, pos + t.end];
    } catch {
      /* invalid after all */
    }
  }
  const lineEnd = (() => {
    const nl = code.indexOf('\n', pos);
    return nl === -1 ? code.length : nl;
  })();
  let start = pos;
  while (start > 0 && WORDISH.test(code[start - 1])) start--;
  // The character the token starts with (`#`, `/`, a quote, …), if acorn is past it.
  if (start > 0 && !/[\s;,)\]}]/.test(code[start - 1]) && !WORDISH.test(code[start - 1]) && start === pos) start--;
  if (/['"`]/.test(code[start] ?? '')) return [start, lineEnd];
  // A literal V8 read whole but couldn't compile (`/a(/`): all of it, as its
  // message quotes it; an unterminated one: its first character.
  const literal = /^Invalid regular expression: (\/.*\/[a-z]*): /.exec(message);
  if (literal) return [start, start + literal[1].length];
  if (/^Invalid regular expression/.test(message)) return [start, start + 1];
  let runEnd = start;
  while (runEnd < code.length && WORDISH.test(code[runEnd])) runEnd++;
  // An escape: V8 marks what it scanned of it, `\u{110000` (not the
  // closing brace), `\x4"` (through the character that ended it).
  const esc = code.indexOf('\\', Math.max(0, start - 1));
  if (esc !== -1 && esc < Math.max(runEnd, pos + 1)) {
    if (code.startsWith('\\u{', esc)) {
      const close = code.indexOf('}', esc);
      return [esc, close === -1 ? runEnd : close];
    }
    if (/^\\[xu]/.test(code.slice(esc))) {
      let k = esc + 2;
      while (/[0-9a-fA-F]/.test(code[k] ?? '')) k++;
      return [esc, k + 1];
    }
    return [start, runEnd];
  }
  return [start, Math.max(pos, start + 1)];
}

/** acorn's message as V8 words it (the common cases). */
function v8Message(acornMessage, code, pos) {
  const msg = String(acornMessage).replace(/ \(\d+:\d+\)$/, '');
  if (code.slice(pos).trim() === '') return 'Unexpected end of input';
  if (/'return' outside of function/.test(msg)) return 'Illegal return statement';
  // Strict code's reserved words (a module's), as V8 words them.
  const reserved = /^The keyword '(\w+)' is reserved$/.exec(msg);
  if (reserved) {
    return /^(let|static|implements|interface|package|private|protected|public|yield)$/.test(reserved[1])
      ? 'Unexpected strict mode reserved word'
      : 'Unexpected reserved word';
  }
  if (/^'import' and 'export' may appear only with 'sourceType: module'/.test(msg)) {
    return 'Cannot use import statement outside a module';
  }
  if (msg === 'Unexpected token') {
    let tok;
    try {
      tok = acorn.tokenizer(code.slice(pos), { ecmaVersion: 'latest' }).getToken();
    } catch {
      return 'Invalid or unexpected token';
    }
    const text = code.slice(pos + tok.start, pos + tok.end);
    if (tok.type.label === 'name') return `Unexpected identifier '${text}'`;
    if (tok.type.label === 'num') return 'Unexpected number';
    if (tok.type.label === 'string') return 'Unexpected string';
    if (tok.type.label === 'template' || tok.type.label === '`') return 'Unexpected template string';
    return `Unexpected token '${text}'`;
  }
  return msg;
}

/**
 * @param {string} source what was compiled (a `#!` line blanked or not)
 * @param {object} o
 * @param {'script'|'commonjs'|'module'|'jsh'} o.kind
 * @param {string} o.filename the name Node prints (a path, or a file: URL for a module)
 * @param {SyntaxError} [o.error] the engine's error, if there was one (its message wins)
 * @returns {{ stack: string, message: string, line: number } | null}
 */
export function syntaxReport(source, { kind, filename, error }) {
  const module = kind === 'module';
  try {
    acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: module ? 'module' : 'script',
      allowHashBang: true,
      allowReturnOutsideFunction: kind === 'commonjs' || kind === 'jsh',
      allowAwaitOutsideFunction: module || kind === 'jsh',
      locations: true,
    });
    return null;
  } catch (e) {
    if (!(e instanceof SyntaxError) || e.pos === undefined) return null;
    let pos = e.pos;
    // The engine's own message where it compiled the source as such (a
    // script, a CommonJS wrapper, a .jsh body); an ES module was parsed by
    // acorn, so V8's comes from the same source as an async function body,
    // unless what's wrong is module syntax.
    // At the end of the source, V8 says so (a wrapper's closing brace is
    // what its own compile saw there).
    let message = module || atEnd(source, pos) ? undefined : error?.message;
    if (!message) {
      try {
        // A module is strict code.
        // eslint-disable-next-line no-new-func
        if (module) new AsyncFunction(`'use strict';${withoutModuleSyntax(source)}`);
        // eslint-disable-next-line no-new-func
        else if (kind === 'jsh') new AsyncFunction(source);
        // eslint-disable-next-line no-new-func
        else new Function(source);
      } catch (v8err) {
        if (v8err instanceof SyntaxError && !/import statement|Unexpected token 'export'|import\.meta/.test(v8err.message)) {
          message = v8err.message;
        }
      }
    }
    if (atEnd(source, pos)) message = 'Unexpected end of input';
    message ??= v8Message(e.message, source, pos);
    // The end of the input is where V8 reports that (the last line, after
    // a final newline an empty one), whatever acorn's place.
    const eoiAt = message === 'Unexpected end of input' && pos < source.length;
    if (eoiAt) pos = source.length;
    const lineStart = source.lastIndexOf('\n', pos - 1) + 1;
    let lineEnd = source.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = source.length;
    // A BOM the file starts with stays in the line shown, and counts as a column (Node's).
    const text = source.slice(lineStart, lineEnd);
    const [start, spanEnd] = markSpan(source, pos, message);
    const from = Math.max(lineStart, Math.min(start, pos));
    const end = Math.min(spanEnd, lineEnd);
    // At the end of the input V8 marks nothing (an unterminated template too).
    const eoi = message === 'Unexpected end of input';
    const carets = pos >= lineEnd || eoi ? '' : '^'.repeat(Math.max(1, end - from));
    const line = (!eoiAt && e.loc?.line) || source.slice(0, pos).split('\n').length;
    return {
      line,
      message,
      stack: `${filename}:${line}\n${text}\n${eoi && pos < lineEnd ? '' : ' '.repeat((pos >= lineEnd ? pos : from) - lineStart)}${carets}\n\nSyntaxError: ${message}`,
    };
  }
}

/**
 * `node --check`: the source compiled as the module it is, nothing run
 * (Node's internal/main/check_syntax). Returns null when it compiles, else
 * the SyntaxError, its report under `filename` (a path, as Node names a
 * checked file, not a URL).
 */
export function checkSyntax(source, { kind, filename }) {
  // A hashbang line goes, its newline stays (lines keep their numbers).
  const body = source.startsWith('#!') ? (source.includes('\n') ? source.slice(source.indexOf('\n')) : '') : source;
  let error;
  if (kind === 'module') {
    try {
      acorn.parse(body, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true });
      return null;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      error = new SyntaxError(err.message);
    }
  } else {
    try {
      // eslint-disable-next-line no-new-func
      new Function('exports', 'require', 'module', '__filename', '__dirname', body);
      return null;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      error = err;
      // A top-level declaration of a wrapper name: module syntax to Node's
      // containsModuleSyntax (detect-module then takes it as an ES module).
      if (/has already been declared/.test(err.message) && /\b(exports|require|module|__filename|__dirname)\b/.test(err.message)) {
        Object.defineProperty(error, 'wrapperRedeclare', { value: true, configurable: true });
      }
    }
  }
  let stack = syntaxReport(source, { kind, filename, error })?.stack;
  if (!stack) {
    // Valid as a script, not inside the CommonJS wrapper (`const require`):
    // V8 marks the wrapper's name on the first line it is declared on.
    const lines = body.split('\n');
    const n = Math.max(0, lines.findIndex((l) => /\b(exports|require|module|__filename|__dirname)\b/.test(l)));
    const line = lines[n] ?? '';
    const at = /\b(exports|require|module|__filename|__dirname)\b/.exec(line);
    const col = at ? at.index : 0;
    stack = `${filename}:${n + 1}\n${line}\n${' '.repeat(col)}^\n\nSyntaxError: ${error.message}`;
  }
  Object.defineProperty(error, '_prettyStack', { value: stack, configurable: true, writable: true });
  error.stack = stack;
  return error;
}
