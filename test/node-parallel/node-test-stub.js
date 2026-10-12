'use strict';
// A minimal `node:test` for the node-parallel harness: slicc-jsh has no test
// runner yet, and many of Node's test/parallel files only use test() /
// describe() / it() to group plain assertions. Tests run one after another;
// a failure is printed and makes the exit status 1.
const queue = [];
let running = false;

function run() {
  if (running) return;
  running = true;
  (async () => {
    while (queue.length) {
      const { name, fn } = queue.shift();
      try {
        await runOne(fn);
      } catch (err) {
        process.exitCode = 1;
        console.error(`not ok - ${name}`);
        console.error(err);
      }
    }
    running = false;
  })();
}

async function runOne(fn) {
  const subtests = [];
  const t = {
    test: (name, opts, f) => subtests.push(normalize(name, opts, f)),
    skip() {},
    todo() {},
    diagnostic() {},
    plan() {},
    mock: undefined,
    assert: require('assert'),
  };
  t.it = t.test;
  if (fn.length >= 2) {
    await new Promise((resolve, reject) => fn(t, (err) => (err ? reject(err) : resolve())));
  } else {
    await fn(t);
  }
  for (const s of subtests) if (!s.skip) await runOne(s.fn);
}

function normalize(name, opts, fn) {
  if (typeof name === 'function') return { name: name.name || '<anonymous>', fn: name };
  if (typeof opts === 'function') return { name, fn: opts };
  return { name, fn: fn ?? (() => {}), skip: opts?.skip || opts?.todo };
}

function test(name, opts, fn) {
  const t = normalize(name, opts, fn);
  if (!t.skip) queue.push(t);
  run();
}
test.test = test;
test.describe = test;
test.it = test;
test.suite = test;
test.skip = () => {};
test.todo = () => {};
test.before = (fn) => fn();
test.after = () => {};
test.beforeEach = () => {};
test.afterEach = () => {};
test.mock = undefined;
module.exports = test;
