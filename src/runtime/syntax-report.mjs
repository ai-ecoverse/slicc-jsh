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
 * The span V8 marks for an error at acorn's `pos`, as [start, end].
 * - A token V8 could read: that token.
 * - An invalid one ("Invalid or unexpected token", a regular expression):
 *   V8 marks from where the token starts (acorn points past its start, as in
 *   `0x`, `1n2`, `#`, `/ab`) up to where its scanner gave up — an escape
 *   (`\u{110000}`) to its end, a string or template to the line's end, a
 *   regular expression its first character.
 */
const WORDISH = /[\w$\\{}]/;
function markSpan(code, pos, message) {
  const invalid = /^(Invalid or unexpected token|Invalid regular expression|Undefined Unicode code-point|Invalid (Unicode|hexadecimal) escape sequence)/.test(
    message
  );
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
        if (module) new AsyncFunction(`'use strict';${source}`);
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
