/**
 * The goldens' no-progress watchdog (scripts/golden.mjs, scripts/jsh-golden.mjs),
 * after ai-ecoverse/slicc-kernel#880.
 */

// A run fails when it stops making progress, not at a set time: QUIET_MS
// with no output from it, or MAX_MS in all, for one that keeps printing and
// never ends. A loaded runner makes a run slower; it doesn't make it quiet.
// (The longest quiet stretch of a golden today is 4.2 s, http-server-timeouts-close.)
export const QUIET_MS = 30_000;
export const MAX_MS = 300_000;

/** Watches a run: `seen(chunk)` on its output; `fail(error)` once, on no progress. */
export function watchdog(label, fail) {
  const start = Date.now();
  let last = start;
  let tail = '';
  let failed = false;
  const stop = () => {
    clearInterval(quiet);
    clearTimeout(outer);
  };
  const give = (message) => {
    if (failed) return;
    failed = true;
    stop();
    const error = new Error(`${label}: ${message} after ${Math.round((Date.now() - start) / 1000)} s; ${tail ? `it last printed ${JSON.stringify(tail)}` : 'it printed nothing'}`);
    error.code = 'ETIMEDOUT';
    fail(error);
  };
  const quiet = setInterval(() => {
    if (Date.now() - last >= QUIET_MS) give(`no output for ${QUIET_MS / 1000} s`);
  }, 1000);
  const outer = setTimeout(() => give(`still running`), MAX_MS);
  return {
    seen(chunk) {
      last = Date.now();
      tail = (tail + String(chunk)).slice(-120);
    },
    stop,
  };
}
