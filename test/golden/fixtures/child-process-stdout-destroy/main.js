const cp = require('child_process');

// The child catches SIGPIPE so a write to the closed pipe fails with EPIPE
// (without a handler, Node ignores SIGPIPE: an unhandled EPIPE then ends it).
// It reports on the other stream, which the parent still reads.
const say = (fd) => `(m) => require("fs").writeSync(${3 - fd}, m + "\\n")`;
const once = (fd) =>
  `const say = ${say(fd)}; process.on("SIGPIPE", () => {}); setTimeout(() => { try { require("fs").writeSync(${fd}, "late\\n"); say("wrote"); } catch (e) { say("child " + e.code); } }, 300)`;
const loop = (fd) =>
  `const say = ${say(fd)}; process.on("SIGPIPE", () => {}); let i = 0; const t = setInterval(() => { try { require("fs").writeSync(${fd}, "x\\n") } catch (e) { say("child " + e.code); clearInterval(t) } if (++i > 300) { say("never failed"); clearInterval(t) } }, 2)`;

function run(label, src, slot, destroy) {
  return new Promise((resolve) => {
    const stdio = ['ignore', 'pipe', 'pipe'];
    const c = cp.spawn('node', ['-e', src], { stdio });
    const other = slot === 'stdout' ? c.stderr : c.stdout;
    let said = '';
    other.on('data', (d) => (said += d));
    destroy(c[slot]);
    c.on('close', (code, sig) => {
      console.log(label, code, sig, JSON.stringify(said.trim()), c[slot].destroyed);
      resolve();
    });
  });
}

(async () => {
  await run('stdout destroyed at once', once(1), 'stdout', (s) => s.destroy());
  await run('stdout destroyed after data', loop(1), 'stdout', (s) => s.once('data', () => s.destroy()));
  await run('stderr destroyed at once', once(2), 'stderr', (s) => s.destroy());
  await run('stderr destroyed after data', loop(2), 'stderr', (s) => s.once('data', () => s.destroy()));
})();
