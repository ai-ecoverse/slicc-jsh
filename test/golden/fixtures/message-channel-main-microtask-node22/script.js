const busy = () => { const t = Date.now(); while (Date.now() - t < 80); };
const cases = [];
const start = (name, setup, L = []) => {
  const { port1, port2 } = new MessageChannel();
  port2.onmessage = (e) => { L.push('mc ' + e.data); setImmediate(() => L.push('imm from ' + e.data)); };
  const post = () => { port1.postMessage('x'); port1.postMessage('y'); };
  const timer = () => setTimeout(() => L.push('timer 60'), 60);
  setup({ L, post, timer, imm: () => setImmediate(() => L.push('imm')) });
  setTimeout(() => {
    console.log(name + ':', L.join(' | '));
    port1.close();
    const next = cases.shift();
    if (next) setTimeout(next, 5);
  }, 300);
};
const fromTimer = (name, setup) => cases.push(() => start(name, setup));
const fromImmediate = (name, setup) => cases.push(() => setImmediate(() => start(name, setup)));

start('main, long microtask after the posts', ({ post, timer, imm }) => { imm(); post(); timer(); queueMicrotask(busy); });
fromTimer('timer, long microtask before the posts', ({ post, timer, imm }) => { imm(); queueMicrotask(busy); post(); timer(); });
fromTimer('timer, busy after the posts', ({ post, timer, imm }) => { imm(); post(); timer(); busy(); });
fromImmediate('immediate, long microtask after the posts', ({ post, timer, imm }) => { imm(); post(); timer(); queueMicrotask(busy); });
fromImmediate('immediate, long microtask before the posts', ({ post, timer, imm }) => { imm(); queueMicrotask(busy); post(); timer(); });
fromImmediate('immediate, busy after the posts', ({ post, timer, imm }) => { imm(); post(); timer(); busy(); });
fromImmediate('immediate, busy before the timer', ({ post, timer, imm }) => { imm(); busy(); timer(); post(); });
cases.push(() => {
  const L = [];
  setImmediate(() => start('immediate, another queued before it ran', ({ post, imm }) => { post(); imm(); }, L));
  setImmediate(() => L.push('imm queued before'));
});
