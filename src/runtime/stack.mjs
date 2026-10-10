/**
 * Error.prepareStackTrace: drop kernel-origin frames; rename Object.eval →
 * Object.<anonymous>; correct V8 new-Function line numbers (−2).
 */

const KERNEL_HINT =
  /node-process-worker|runJsProcess|createNodeKernel|data:text\/javascript|@ai-ecoverse\/slicc-kernel|\/slicc-kernel\/|slicc-jsh\/dist\/|at new Function\b/i;

function isKernelFrame(frame) {
  const file = frame.getFileName?.() || '';
  const text = typeof frame.toString === 'function' ? frame.toString() : '';
  const fn = frame.getFunctionName?.() || '';
  if (KERNEL_HINT.test(file) || KERNEL_HINT.test(text) || KERNEL_HINT.test(fn)) return true;
  if (file.startsWith('data:')) return true;
  return false;
}

/** V8 reports Function-body lines 2 higher than the sourceURL file. */
function adjustLine(n) {
  if (n == null || Number.isNaN(n)) return n;
  return n >= 3 ? n - 2 : n;
}

function formatFrame(frame) {
  let text = typeof frame.toString === 'function' ? frame.toString() : '';
  text = text
    .replace(/\bObject\.eval\b/g, 'Object.<anonymous>')
    .replace(/\bProxy\./g, 'Object.')
    .replace(/^eval /, 'Object.<anonymous> ')
    .replace(/\beval \(/g, 'Object.<anonymous> (');

  // Rewrite path:line:col with adjusted line.
  text = text.replace(
    /(\[eval\]|\/[^:)\s]+):(\d+):(\d+)/g,
    (_, file, ln, col) => `${file}:${adjustLine(Number(ln))}:${col}`
  );

  const evalOnly = /^Object\.<anonymous> \(?(\[eval\]:\d+:\d+)\)?$/.exec(text);
  if (evalOnly) return `    at ${evalOnly[1]}`;
  if (/^\[eval\]:\d+:\d+$/.test(text)) return `    at ${text}`;
  return `    at ${text}`;
}

/** Install once per runNode. */
export function installStackPrepare() {
  Error.prepareStackTrace = (err, frames) => {
    // Preserve loader-formatted SyntaxError pretty stacks (snippet + caret).
    if (err.name === 'SyntaxError' && err._prettyStack) return err._prettyStack;
    const kept = frames.filter((f) => !isKernelFrame(f));
    const first = `${err.name || 'Error'}: ${err.message}`;
    return [first, ...kept.map(formatFrame)].join('\n');
  };
}

export { isKernelFrame, KERNEL_HINT, adjustLine };
