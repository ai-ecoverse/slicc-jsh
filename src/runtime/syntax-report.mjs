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

/** The end of the token at `pos` (for the carets): an invalid one runs to the end of its line, as V8 marks it. */
function tokenEnd(code, pos) {
  try {
    const t = acorn.tokenizer(code.slice(pos), { ecmaVersion: 'latest', allowHashBang: true }).getToken();
    if (t.end > t.start) return pos + t.end;
  } catch {
    const nl = code.indexOf('\n', pos);
    return nl === -1 ? code.length : nl;
  }
  return pos + 1;
}

/** acorn's message as V8 words it (the common cases). */
function v8Message(acornMessage, code, pos) {
  const msg = String(acornMessage).replace(/ \(\d+:\d+\)$/, '');
  if (code.slice(pos).trim() === '') return 'Unexpected end of input';
  if (/'return' outside of function/.test(msg)) return 'Illegal return statement';
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
    const pos = e.pos;
    // The engine's own message where it compiled the source as such (a
    // script, a CommonJS wrapper, a .jsh body); an ES module was parsed by
    // acorn, so V8's comes from the same source as an async function body,
    // unless what's wrong is module syntax.
    // At the end of the source, V8 says so (a wrapper's closing brace is
    // what its own compile saw there).
    let message = module || atEnd(source, pos) ? undefined : error?.message;
    if (!message) {
      try {
        // eslint-disable-next-line no-new-func
        if (kind === 'jsh' || module) new AsyncFunction(source);
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
    const lineStart = source.lastIndexOf('\n', pos - 1) + 1;
    let lineEnd = source.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = source.length;
    const text = source.slice(lineStart, lineEnd);
    const end = Math.min(tokenEnd(source, pos), lineEnd);
    const carets = pos >= lineEnd ? '' : '^'.repeat(Math.max(1, end - pos));
    const line = e.loc?.line ?? source.slice(0, pos).split('\n').length;
    return {
      line,
      message,
      stack: `${filename}:${line}\n${text}\n${' '.repeat(pos - lineStart)}${carets}\n\nSyntaxError: ${message}`,
    };
  }
}
